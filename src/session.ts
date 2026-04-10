import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	stream,
	streamSimple,
	type Tool,
} from "@mariozechner/pi-ai";
import type { Span } from "@opentelemetry/api";
import { AskStreamImpl } from "./ask-stream";
import { type CompactionSettings, maybeCompact } from "./compaction";
import type { ThinkingConfig } from "./config";
import { cleanupWorktree, type Repo } from "./forge";
import { consoleLogger, type Logger } from "./logger";
import { type ParsedLink, validateLinks } from "./response-validation";
import { processStream, processStreamToEvents, type StreamFn } from "./stream-processor";
import {
	endAskSpan,
	endAskSpanWithError,
	endCompactionSpan,
	endCompactionSpanWithError,
	endGenerationSpan,
	endGenerationSpanWithError,
	endToolSpan,
	endToolSpanWithError,
	startAskSpan,
	startCompactionSpan,
	startGenerationSpan,
	startToolSpan,
} from "./tracing";
import type { AskStream, NewAskOptions, StreamEvent, TurnMetadata, TurnResult } from "./types";

// =============================================================================
// Types
// =============================================================================

/** Record of a tool call made during a session */
export interface ToolCallRecord {
	/** Unique identifier for this tool call (from the model response) */
	id: string;
	/** Name of the tool that was called */
	name: string;
	/** Arguments passed to the tool */
	arguments: Record<string, unknown>;
	/** Output returned by the tool */
	output: string;
	/** Whether the tool execution resulted in an error */
	isError: boolean;
	/** Time taken to execute the tool in milliseconds */
	durationMs: number;
}

/** Structured error from a failed ask operation */
export interface AskError {
	/** Human-readable error message */
	message: string;
	/** Raw error details for debugging (e.g., API error object) */
	details?: unknown;
}

/** Result returned from Session.ask() */
export interface AskResult {
	/** The original question/prompt */
	prompt: string;
	/** List of tool calls made while answering */
	toolCalls: ToolCallRecord[];
	/** The final response text (or error message for backward compat) */
	response: string;
	/** Structured error, or null if the turn completed successfully */
	error: AskError | null;
	/** Token usage statistics */
	usage: Usage;
	/** Total time taken for inference in milliseconds */
	inferenceTimeMs: number;
	/** Total number of repo-pointing links found in the response */
	totalLinks: number;
	/** Links in the response whose repo-relative paths could not be found on disk */
	invalidLinks: InvalidLink[];
	/** The effort level the model actually used (from response output_config). Undefined if thinking is off. */
	responseEffort?: string;
}

/** A link in the response that points to a non-existent file path */
export interface InvalidLink {
	/** The URL from the markdown link */
	url: string;
	/** The repo-relative path extracted from the URL */
	repoPath: string;
}

/** Token usage statistics for an ask operation */
export interface Usage {
	/** Number of input tokens */
	inputTokens: number;
	/** Number of output tokens */
	outputTokens: number;
	/** Total tokens (input + output) */
	totalTokens: number;
	/** Tokens read from cache */
	cacheReadTokens: number;
	/** Tokens written to cache */
	cacheWriteTokens: number;
}

/**
 * Progress events emitted during Session.ask() via the onProgress callback.
 *
 * Event sequence:
 * 0. "compaction" - Context compacted (if needed, before LLM call)
 * 1. "thinking" - Emitted at the start of each iteration
 * 2. "thinking_delta" - Model's thinking/reasoning (streaming)
 * 3. "text_delta" - Response text (streaming)
 * 4. "tool_start" - Tool call initiated
 * 5. "tool_delta" - Tool call arguments (streaming)
 * 6. "tool_end" - Tool call complete with final arguments
 * 7. "responding" - Final response ready (no more tool calls)
 */
export type ProgressEvent =
	| {
			type: "compaction";
			summary: string;
			firstKeptOrdinal: number;
			tokensBefore: number;
			tokensAfter: number;
			readFiles: string[];
			modifiedFiles: string[];
	  }
	| { type: "thinking" }
	| { type: "thinking_delta"; delta: string }
	| { type: "text_delta"; delta: string }
	| { type: "tool_start"; name: string; arguments: Record<string, unknown> }
	| { type: "tool_delta"; name: string; delta: string }
	| { type: "tool_end"; name: string; arguments: Record<string, unknown> }
	| { type: "responding" };

/** Callback function for receiving progress events during ask() */
export type OnProgress = (event: ProgressEvent) => void;

/** Options for Session.ask() */
export interface AskOptions {
	/** Callback for real-time progress events */
	onProgress?: OnProgress;
}

export type { Message };

// =============================================================================
// Helper Functions
// =============================================================================

function createEmptyUsage(): Usage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
}

function accumulateUsage(accumulated: Usage, response: AssistantMessage): void {
	if (response.usage) {
		accumulated.inputTokens += response.usage.input ?? 0;
		accumulated.outputTokens += response.usage.output ?? 0;
		accumulated.totalTokens += response.usage.totalTokens ?? 0;
		accumulated.cacheReadTokens += response.usage.cacheRead ?? 0;
		accumulated.cacheWriteTokens += response.usage.cacheWrite ?? 0;
	}
}

/** Context for building results throughout an ask operation */
interface AskContext {
	question: string;
	toolCalls: ToolCallRecord[];
	usage: Usage;
	startTime: number;
	/** Last response effort extracted from output_config (set per-iteration). */
	responseEffort?: string;
}

/** Extract the effort level from pi-ai's AssistantMessage (patched to include outputConfig). */
function extractResponseEffort(response: AssistantMessage): string | undefined {
	const msg = response as unknown as { outputConfig?: { effort?: string } };
	return msg.outputConfig?.effort;
}

function formatToolExecutionError(toolName: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const detail = message.trim() || "Unknown error";
	return `[ERROR] Tool execution failed for ${toolName}: ${detail}`;
}

function buildResult(
	ctx: AskContext,
	response: string,
	options: {
		linkStats?: { totalLinks: number; invalidLinks: InvalidLink[] };
		error?: AskError;
	} = {},
): AskResult {
	const { linkStats = { totalLinks: 0, invalidLinks: [] }, error } = options;
	return {
		prompt: ctx.question,
		toolCalls: ctx.toolCalls,
		response,
		error: error ?? null,
		usage: ctx.usage,
		inferenceTimeMs: Date.now() - ctx.startTime,
		totalLinks: linkStats.totalLinks,
		invalidLinks: linkStats.invalidLinks,
		responseEffort: ctx.responseEffort,
	};
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
 * - Multi-turn conversations with message history
 * - Tool execution (file reading, code search, etc.)
 * - Progress callbacks for streaming UI updates
 * - Automatic cleanup of git worktrees on close
 *
 * @example
 * ```ts
 * const session = await connect(repoUrl);
 * const result = await session.ask("What does this repo do?");
 * console.log(result.response);
 * session.close();
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
	#pending: Promise<AskResult> | null = null;
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
	 * The model will use available tools to explore the codebase and formulate an answer.
	 * Concurrent calls are serialized (queued) to maintain conversation coherence.
	 *
	 * @param question - The question to ask
	 * @param options - Optional settings including progress callback
	 * @returns Result containing the response, tool calls made, and usage statistics
	 * @throws Error if the session has been closed
	 */
	async ask(question: string, options?: AskOptions): Promise<AskResult> {
		if (this.#closed) {
			throw new Error(`Session ${this.id} is closed`);
		}

		// Serialize concurrent calls
		if (this.#pending) {
			await this.#pending;
		}

		this.#pending = this.#doAsk(question, options?.onProgress);
		const result = await this.#pending;
		this.#pending = null;
		return result;
	}

	/**
	 * Ask a question and get a streaming response (new API).
	 *
	 * Returns an AskStream synchronously. The stream starts producing events
	 * when consumed (iterated or .result() awaited).
	 * Concurrent calls are serialized — the second stream won't produce
	 * events until the first completes.
	 *
	 * @throws Error (synchronous) if the session is closed
	 */
	askStream(prompt: string, options?: NewAskOptions): AskStream {
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
			() => this.#doAskStream(prompt, prevPending, resolveStreamDone, options),
			(turn) => {
				this.#turns.push(turn);
				this.#turnMessages.set(turn.id, [...this.#context.messages]);
			},
		);
	}

	/**
	 * Get all messages in the conversation history.
	 * Includes user messages, assistant responses, and tool results.
	 */
	getMessages(): Message[] {
		return this.#context.messages;
	}

	/**
	 * Replace the entire conversation history.
	 * Useful for restoring a previous session state.
	 *
	 * @param messages - The new message history
	 */
	replaceMessages(messages: Message[]): void {
		this.#context.messages = messages;
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

	async *#doAskStream(
		prompt: string,
		prevPending: Promise<unknown>,
		onDone: () => void,
		options?: NewAskOptions,
	): AsyncGenerator<StreamEvent> {
		try {
			// Serialize with any previous askStream call
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
				yield* this.#executeToolCallsStream(responseToolCalls);
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

	async *#executeToolCallsStream(
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

	async #doAsk(question: string, onProgress?: OnProgress): Promise<AskResult> {
		const ctx: AskContext = {
			question,
			toolCalls: [],
			usage: createEmptyUsage(),
			startTime: Date.now(),
		};

		const modelId = `${this.#config.model.provider}/${this.#config.model.id}`;
		const askSpan = startAskSpan({
			question,
			sessionId: this.id,
			repoUrl: this.repo.url,
			commitish: this.repo.commitish,
			model: modelId,
			systemPrompt: this.#context.systemPrompt,
		});

		// Check for compaction before adding the new question
		// Include the new question in the token estimate since it will be added to context
		const newQuestionMessage: Message = { role: "user", content: question, timestamp: Date.now() };
		const messagesWithQuestion = [...this.#context.messages, newQuestionMessage];

		const compactionSpan = startCompactionSpan(askSpan);
		try {
			const compactionResult = await maybeCompact(this.#config.model, messagesWithQuestion, this.#compactionSummary);

			if (compactionResult.wasCompacted) {
				// Replace session messages with compacted version (includes the new question)
				this.#context.messages = compactionResult.messages;
				this.#compactionSummary = compactionResult.summary;

				this.#logger.log(
					"[compaction]",
					`Context compacted: ${compactionResult.tokensBefore} -> ${compactionResult.tokensAfter} tokens`,
				);

				endCompactionSpan(compactionSpan, {
					wasCompacted: true,
					tokensBefore: compactionResult.tokensBefore,
					tokensAfter: compactionResult.tokensAfter,
				});

				// Notify via progress callback
				onProgress?.({
					type: "compaction",
					summary: compactionResult.summary ?? "",
					firstKeptOrdinal: compactionResult.firstKeptOrdinal,
					tokensBefore: compactionResult.tokensBefore,
					tokensAfter: compactionResult.tokensAfter,
					readFiles: compactionResult.readFiles,
					modifiedFiles: compactionResult.modifiedFiles,
				});
			} else {
				// No compaction needed, just add the question
				this.#context.messages.push(newQuestionMessage);
				endCompactionSpan(compactionSpan, { wasCompacted: false });
			}
		} catch (compactionError) {
			// Compaction failed - log error but continue (just add the question)
			this.#logger.error("[compaction] Error during compaction:", compactionError);
			this.#context.messages.push(newQuestionMessage);
			endCompactionSpanWithError(compactionSpan, compactionError);
		}

		try {
			for (let iteration = 0; iteration < this.#config.maxIterations; iteration++) {
				onProgress?.({ type: "thinking" });

				const iterationResult = await this.#processIteration(ctx, iteration, askSpan, onProgress);

				if (iterationResult.done) {
					const result = iterationResult.result;
					endAskSpan(askSpan, {
						toolCallCount: result.toolCalls.length,
						totalIterations: iteration + 1,
						totalLinks: result.totalLinks,
						invalidLinks: result.invalidLinks.length,
						usage: result.usage,
					});
					return result;
				}
			}

			const msg = "Max iterations reached without a final answer.";
			const result = buildResult(ctx, `[ERROR: ${msg}]`, { error: { message: msg } });
			endAskSpanWithError(askSpan, "max_iterations_reached");
			return result;
		} catch (error) {
			endAskSpanWithError(askSpan, "unexpected_error", error);
			throw error;
		}
	}

	async #processIteration(
		ctx: AskContext,
		iteration: number,
		askSpan: Span,
		onProgress?: OnProgress,
	): Promise<{ done: true; result: AskResult } | { done: false }> {
		const modelId = `${this.#config.model.provider}/${this.#config.model.id}`;
		const genSpan = startGenerationSpan(askSpan, {
			iteration: iteration + 1,
			model: modelId,
			provider: String(this.#config.model.provider),
			messages: [...this.#context.messages],
		});

		const { streamFn, streamOptions } = this.#resolveStreamCall();
		const outcome = await processStream(streamFn, this.#config.model, this.#context, onProgress, streamOptions);

		if (!outcome.ok) {
			endGenerationSpanWithError(genSpan, outcome.errorDetails ?? outcome.error);
			this.#logger.error(`API call failed (iteration ${iteration + 1})`, {
				...(typeof outcome.errorDetails === "object" ? outcome.errorDetails : { error: outcome.errorDetails }),
				iteration: iteration + 1,
				timestamp: new Date().toISOString(),
			});
			return {
				done: true,
				result: buildResult(ctx, `[ERROR: ${outcome.error}]`, {
					error: { message: outcome.error, details: outcome.errorDetails },
				}),
			};
		}

		const response = outcome.response;
		accumulateUsage(ctx.usage, response);

		// Capture the response effort from the patched output_config (last iteration wins)
		const effort = extractResponseEffort(response);
		if (effort) ctx.responseEffort = effort;

		// Check for API error in response (fields may exist but not be in pi-ai's public types)
		const apiError = response as unknown as { stopReason?: string; errorMessage?: string };
		if (apiError.stopReason === "error" || apiError.errorMessage) {
			const errorMsg = apiError.errorMessage || "Unknown API error";
			endGenerationSpanWithError(genSpan, errorMsg);
			this.#logger.error("API ERROR", {
				iteration: iteration + 1,
				stopReason: apiError.stopReason,
				errorMessage: errorMsg,
				timestamp: new Date().toISOString(),
				fullResponse: response,
			});
			return {
				done: true,
				result: buildResult(ctx, `[ERROR: ${errorMsg}]`, {
					error: { message: errorMsg, details: { stopReason: apiError.stopReason } },
				}),
			};
		}

		this.#context.messages.push(response);

		// Check if we have a final text response (no tool calls)
		const responseToolCalls = response.content.filter((b) => b.type === "toolCall");
		if (responseToolCalls.length === 0) {
			const textBlocks = response.content.filter((b) => b.type === "text");
			const responseText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");
			if (!responseText.trim()) {
				endGenerationSpanWithError(genSpan, "Empty response from API");
			} else {
				endGenerationSpan(genSpan, {
					output: response.content,
					inputTokens: response.usage?.input ?? 0,
					outputTokens: response.usage?.output ?? 0,
					cacheReadTokens: response.usage?.cacheRead ?? 0,
					cacheCreationTokens: response.usage?.cacheWrite ?? 0,
					stopReason: (response as unknown as { stopReason?: string }).stopReason,
				});
			}
			return {
				done: true,
				result: this.#buildTextResponse(ctx, response, onProgress),
			};
		}

		// Execute tool calls as children of this gen_ai.chat span
		// Unknown tool names flow through executeTool, which returns an error string
		// as a tool result — giving the model a chance to self-correct on the next iteration.
		await this.#executeToolCalls(responseToolCalls, ctx.toolCalls, genSpan);

		endGenerationSpan(genSpan, {
			output: response.content,
			inputTokens: response.usage?.input ?? 0,
			outputTokens: response.usage?.output ?? 0,
			cacheReadTokens: response.usage?.cacheRead ?? 0,
			cacheCreationTokens: response.usage?.cacheWrite ?? 0,
			stopReason: (response as unknown as { stopReason?: string }).stopReason,
		});

		return { done: false };
	}

	#buildTextResponse(ctx: AskContext, response: AssistantMessage, onProgress?: OnProgress): AskResult {
		onProgress?.({ type: "responding" });

		const textBlocks = response.content.filter((b) => b.type === "text");
		const responseText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");

		if (!responseText.trim()) {
			this.#logger.error("WARNING: Empty response from API", { fullResponse: response });
			const msg = "Empty response from API - check API key and credits";
			return buildResult(ctx, `[ERROR: ${msg}]`, { error: { message: msg } });
		}

		// Validate links in the response
		const { totalRepoLinks, broken } = validateLinks(responseText, this.repo.localPath);
		const invalidLinks: InvalidLink[] = broken
			.filter((l): l is ParsedLink & { repoPath: string } => l.repoPath !== null)
			.map((l) => ({ url: l.url, repoPath: l.repoPath }));
		if (invalidLinks.length > 0) {
			this.#logger.error(`Found ${invalidLinks.length} invalid link(s) in response:`, invalidLinks);
		}

		this.#logger.log("RESPONSE", "");
		return buildResult(ctx, responseText, { linkStats: { totalLinks: totalRepoLinks, invalidLinks } });
	}

	async #executeToolCalls(
		toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
		toolCallRecords: ToolCallRecord[],
		askSpan: Span,
	): Promise<void> {
		for (const call of toolCalls) {
			this.#logger.log(`TOOL: ${call.name}`, JSON.stringify(call.arguments, null, 2));
		}

		const toolExecStart = Date.now();
		const results = await Promise.all(
			toolCalls.map(async (call) => {
				const toolSpan = startToolSpan(askSpan, {
					toolName: call.name,
					toolCallId: call.id,
					args: call.arguments,
				});
				const t0 = Date.now();
				try {
					const result = await this.#config.executeTool(call.name, call.arguments, this.repo.localPath);
					const durationMs = Date.now() - t0;
					endToolSpan(toolSpan, result);
					this.#logger.log(`TOOL_DONE: ${call.name}`, `${durationMs}ms`);
					return { text: result, isError: false, durationMs };
				} catch (error) {
					const durationMs = Date.now() - t0;
					const errorText = formatToolExecutionError(call.name, error);
					endToolSpanWithError(toolSpan, error, errorText);
					this.#logger.warn(`TOOL_ERROR: ${call.name}`, `${durationMs}ms ${errorText}`);
					return { text: errorText, isError: true, durationMs };
				}
			}),
		);
		this.#logger.log(`ALL_TOOLS_DONE: ${toolCalls.length} calls`, `${Date.now() - toolExecStart}ms`);

		// Push results back in request order to preserve conversation context
		toolCalls.forEach((call, j) => {
			const r = results[j];
			toolCallRecords.push({
				id: call.id,
				name: call.name,
				arguments: call.arguments,
				output: r?.text ?? "",
				isError: r?.isError ?? false,
				durationMs: r?.durationMs ?? 0,
			});
			this.#context.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: r?.text ?? "" }],
				isError: r?.isError ?? false,
				timestamp: Date.now(),
			});
		});
	}
}
