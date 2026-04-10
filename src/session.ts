import { randomUUID } from "node:crypto";
import { type Api, type Context, type Message, type Model, stream, streamSimple, type Tool } from "@mariozechner/pi-ai";
import { AskStreamImpl } from "./ask-stream";
import { type CompactionSettings, maybeCompact } from "./compaction";
import type { ThinkingConfig } from "./config";
import { cleanupWorktree, type Repo } from "./forge";
import { consoleLogger, type Logger } from "./logger";
import { processStreamToEvents, type StreamFn } from "./stream-processor";
import type { AskStream, NewAskOptions, StreamEvent, TurnMetadata, TurnResult } from "./types";

export type { Message };

// =============================================================================
// Helper Functions
// =============================================================================

function formatToolExecutionError(toolName: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const detail = message.trim() || "Unknown error";
	return `[ERROR] Tool execution failed for ${toolName}: ${detail}`;
}

// =============================================================================
// Session Class
// =============================================================================

/**
 * Configuration for creating a Session.
 * All dependencies are injectable for testing.
 */
export interface SessionConfig {
	/** The AI model to use for inference */
	model: Model<Api>;
	/** System prompt that defines the assistant's behavior */
	systemPrompt: string;
	/** Available tools the model can call */
	tools: Tool[];
	/** Maximum number of tool-use iterations before giving up */
	maxIterations: number;
	/** Function to execute tool calls */
	executeTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<string>;
	/** Logger for debug output (defaults to consoleLogger) */
	logger?: Logger;
	/** Raw stream function for AI inference (defaults to pi-ai's stream). Used for adaptive thinking. */
	stream?: StreamFn;
	/** Simple stream function (defaults to pi-ai's streamSimple). Used for level-based thinking. */
	streamSimple?: StreamFn;
	/** Context compaction settings (defaults to sensible values) */
	compaction?: Partial<CompactionSettings>;
	/** Thinking configuration. If omitted, thinking is off. */
	thinking?: ThinkingConfig;
}

/**
 * A Session manages a conversation with an AI model about a code repository.
 *
 * Sessions provide:
 * - Multi-turn conversations with turn-based context
 * - Streaming responses via AskStream (AsyncIterable + .result())
 * - Tool execution (file reading, code search, etc.)
 * - Conversation branching via afterTurn
 * - Automatic cleanup of git worktrees on close
 *
 * @example
 * ```ts
 * const session = await client.connect(repoUrl);
 * const stream = session.ask("What does this repo do?");
 * for await (const event of stream) {
 *   console.log(event.type, event);
 * }
 * const result = await stream.result();
 * ```
 */
export class Session {
	/** Unique identifier for this session */
	readonly id: string;
	/** The repository this session is connected to */
	readonly repo: Repo;

	#config: SessionConfig;
	#logger: Logger;
	#stream: StreamFn;
	#streamSimple: StreamFn;
	#context: Context;
	#streamPending: Promise<unknown> = Promise.resolve();
	#closed = false;
	#compactionSummary: string | undefined = undefined;
	#turns: TurnResult[] = [];
	/** Messages snapshot at the end of each turn, keyed by turn ID. Used for afterTurn branching. */
	#turnMessages = new Map<string, Message[]>();

	constructor(repo: Repo, config: SessionConfig) {
		this.id = randomUUID();
		this.repo = repo;
		this.#config = config;
		this.#logger = config.logger ?? consoleLogger;
		this.#stream = (config.stream ?? stream) as StreamFn;
		this.#streamSimple = (config.streamSimple ?? streamSimple) as StreamFn;
		this.#context = {
			systemPrompt: config.systemPrompt,
			messages: [],
			tools: config.tools,
		};
	}

	/** Resolves which stream function and options to use based on thinking config. */
	#resolveStreamCall(thinkingOverride?: ThinkingConfig): {
		streamFn: StreamFn;
		streamOptions?: Record<string, unknown>;
	} {
		const thinking = thinkingOverride ?? this.#config.thinking;
		if (!thinking) return { streamFn: this.#stream };

		if (thinking.type === "adaptive") {
			return {
				streamFn: this.#stream,
				streamOptions: {
					thinkingEnabled: true,
					...(thinking.effort && { effort: thinking.effort }),
				},
			};
		}

		// Effort-based (cross-provider) — use streamSimple which maps to native format
		return {
			streamFn: this.#streamSimple,
			streamOptions: {
				reasoning: thinking.effort,
				...(thinking.budgetOverrides && { thinkingBudgets: thinking.budgetOverrides }),
			},
		};
	}

	/**
	 * Ask a question about the repository.
	 *
	 * Returns an AskStream synchronously. The stream starts producing events
	 * when consumed (iterated or .result() awaited).
	 * Concurrent calls are serialized — the second stream won't produce
	 * events until the first completes.
	 *
	 * @throws Error (synchronous) if the session is closed
	 * @throws Error (synchronous) if afterTurn references an unknown turn ID
	 */
	ask(prompt: string, options?: NewAskOptions): AskStream {
		if (this.#closed) {
			throw new Error(`Session ${this.id} is closed`);
		}

		// Validate afterTurn synchronously
		if (options?.afterTurn) {
			const found = this.#turns.find((t) => t.id === options.afterTurn);
			if (!found) {
				throw new Error(`Turn not found: ${options.afterTurn}`);
			}
		}

		// Capture the current pending promise for serialization
		const prevPending = this.#streamPending;
		// Create a deferred that we resolve when the stream completes
		let resolveStreamDone: () => void = () => {};
		this.#streamPending = new Promise<void>((resolve) => {
			resolveStreamDone = resolve;
		});
		return new AskStreamImpl(
			() => this.#doAsk(prompt, prevPending, resolveStreamDone, options),
			(turn) => {
				this.#turns.push(turn);
				this.#turnMessages.set(turn.id, [...this.#context.messages]);
			},
		);
	}

	/**
	 * Close the session and clean up resources.
	 *
	 * This removes the git worktree associated with the session.
	 * The session cannot be used after closing.
	 * Safe to call multiple times.
	 */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;

		// Clean up worktree, log if it fails
		const success = await cleanupWorktree(this.repo);
		if (!success) {
			this.#logger.error("Failed to cleanup worktree", { path: this.repo.localPath });
		}
	}

	/** Get all completed turns in chronological order. */
	getTurns(): readonly TurnResult[] {
		return [...this.#turns];
	}

	/** Get a specific turn by ID. Returns null if not found. */
	getTurn(id: string): TurnResult | null {
		return this.#turns.find((t) => t.id === id) ?? null;
	}

	async *#doAsk(
		prompt: string,
		prevPending: Promise<unknown>,
		onDone: () => void,
		options?: NewAskOptions,
	): AsyncGenerator<StreamEvent> {
		try {
			// Serialize with any previous ask call
			await prevPending;

			// If afterTurn is specified, rebuild context from that turn's snapshot
			if (options?.afterTurn) {
				const snapshot = this.#turnMessages.get(options.afterTurn);
				if (snapshot) {
					this.#context.messages = [...snapshot];
				}
			}

			// Check for abort before starting
			if (options?.signal?.aborted) {
				yield { type: "error", message: "Aborted" };
				return;
			}

			const turnId = randomUUID();
			const startedAt = Date.now();
			yield { type: "turn_start", turnId, prompt, timestamp: startedAt };

			// Compaction
			const newQuestionMessage: Message = { role: "user", content: prompt, timestamp: Date.now() };
			const messagesWithQuestion = [...this.#context.messages, newQuestionMessage];

			try {
				const compactionResult = await maybeCompact(this.#config.model, messagesWithQuestion, this.#compactionSummary);
				if (compactionResult.wasCompacted) {
					this.#context.messages = compactionResult.messages;
					this.#compactionSummary = compactionResult.summary;
					yield {
						type: "compaction",
						summary: compactionResult.summary ?? "",
						firstKeptOrdinal: compactionResult.firstKeptOrdinal,
						tokensBefore: compactionResult.tokensBefore,
						tokensAfter: compactionResult.tokensAfter,
						readFiles: compactionResult.readFiles,
						modifiedFiles: compactionResult.modifiedFiles,
					};
				} else {
					this.#context.messages.push(newQuestionMessage);
				}
			} catch {
				this.#context.messages.push(newQuestionMessage);
			}

			const maxIterations = options?.maxIterations ?? this.#config.maxIterations;
			let iterations = 0;

			for (let iteration = 0; iteration < maxIterations; iteration++) {
				// Check for abort before each iteration
				if (options?.signal?.aborted) {
					yield { type: "error", message: "Aborted" };
					yield { type: "turn_end", turnId, metadata: this.#buildTurnMetadata(iterations, startedAt) };
					return;
				}

				iterations = iteration + 1;

				const { streamFn, streamOptions } = this.#resolveStreamCall(options?.thinking);
				const { events, response: getResponse } = processStreamToEvents(
					streamFn,
					this.#config.model,
					this.#context,
					streamOptions,
				);

				// Yield all events from this iteration's LLM call
				let hadError = false;
				for await (const event of events) {
					if (event.type === "error") {
						hadError = true;
						yield event;
						// Error terminates the turn
						yield {
							type: "turn_end",
							turnId,
							metadata: this.#buildTurnMetadata(iterations, startedAt),
						};
						return;
					}
					yield event;
				}

				if (hadError) return;

				// Get the final response message
				const response = await getResponse();
				this.#context.messages.push(response);

				// Check if we have tool calls
				const responseToolCalls = response.content.filter(
					(b): b is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
						b.type === "toolCall",
				);

				if (responseToolCalls.length === 0) {
					// Final text response — turn is done
					yield { type: "turn_end", turnId, metadata: this.#buildTurnMetadata(iterations, startedAt) };
					return;
				}

				// Execute tool calls and yield results
				yield* this.#executeToolCalls(responseToolCalls);
			}

			// Max iterations reached
			yield { type: "error", message: "Max iterations reached without a final answer." };
			yield { type: "turn_end", turnId, metadata: this.#buildTurnMetadata(iterations, startedAt) };
		} finally {
			onDone();
		}
	}

	#buildTurnMetadata(iterations: number, startedAt: number): TurnMetadata {
		return {
			iterations,
			latencyMs: Date.now() - startedAt,
			model: { provider: String(this.#config.model.provider), id: String(this.#config.model.id) },
			repo: { url: this.repo.url, commitish: this.repo.commitish },
			config: {
				maxIterations: this.#config.maxIterations,
				thinkingConfig: this.#config.thinking,
			},
		};
	}

	async *#executeToolCalls(
		toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	): AsyncGenerator<StreamEvent> {
		const results = await Promise.all(
			toolCalls.map(async (call) => {
				const t0 = Date.now();
				try {
					const result = await this.#config.executeTool(call.name, call.arguments, this.repo.localPath);
					return { text: result, isError: false, durationMs: Date.now() - t0 };
				} catch (error) {
					const errorText = formatToolExecutionError(call.name, error);
					return { text: errorText, isError: true, durationMs: Date.now() - t0 };
				}
			}),
		);

		for (let j = 0; j < toolCalls.length; j++) {
			const call = toolCalls[j];
			const r = results[j];
			if (!call || !r) continue;

			// Push tool result into context for next iteration
			this.#context.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: r.text }],
				isError: r.isError,
				timestamp: Date.now(),
			});

			yield {
				type: "tool_result",
				toolCallId: call.id,
				name: call.name,
				output: r.text,
				isError: r.isError,
				durationMs: r.durationMs,
			};
		}
	}
}
