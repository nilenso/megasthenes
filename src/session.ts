import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type Context,
	getModel,
	type Message,
	type Model,
	stream,
	streamSimple,
	type Tool,
} from "@mariozechner/pi-ai";
import { AskStreamImpl } from "./ask-stream";
import { type CompactionSettings, maybeCompact } from "./compaction";
import type { ThinkingConfig } from "./config";
import { MegasthenesError } from "./errors";
import { cleanupRepo, type Repo } from "./forge";
import { consoleLogger, type Logger } from "./logger";
import { processStreamToEvents, type StreamFn } from "./stream-processor";
import {
	type AskTraceRoot,
	endAskSpan,
	endAskSpanWithError,
	endCompactionSpan,
	endCompactionSpanWithError,
	endGenerationSpan,
	endGenerationSpanWithError,
	endRootAskSpan,
	endToolSpan,
	endToolSpanWithError,
	startAskSpan,
	startAskTurnSpan,
	startCompactionSpan,
	startGenerationSpan,
	startToolSpan,
} from "./tracing";
import { reconstructContext } from "./turns-to-messages";
import type {
	AskOptions,
	AskStream,
	ErrorType,
	ModelConfig,
	RepoConfig,
	Retryability,
	StreamEvent,
	TokenUsage,
	TurnError,
	TurnMetadata,
	TurnResult,
} from "./types";

export type { Message };

// =============================================================================
// Helper Functions
// =============================================================================

function formatToolExecutionError(toolName: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const detail = message.trim() || "Unknown error";
	return `[ERROR] Tool execution failed for ${toolName}: ${detail}`;
}

/** Accumulator for per-turn usage totals across iterations. */
interface UsageAccumulator {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

function accumulateUsage(acc: UsageAccumulator, usage: AssistantMessage["usage"]): void {
	if (!usage) return;
	acc.inputTokens += usage.input ?? 0;
	acc.outputTokens += usage.output ?? 0;
	acc.cacheReadTokens += usage.cacheRead ?? 0;
	acc.cacheWriteTokens += usage.cacheWrite ?? 0;
}

/** Shape of a tool call as consumed by Session.#executeToolCalls. */
type ClassifiedToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/**
 * Classify what to do next given the model's final response for an iteration.
 * Pure: no logging, tracing, mutation, or stream emission. Unit-testable.
 */
export type ResponseClassification =
	| { kind: "tool_calls"; toolCalls: ClassifiedToolCall[] }
	| { kind: "final"; text: string }
	| { kind: "empty" };

export function classifyResponse(response: AssistantMessage): ResponseClassification {
	const toolCalls = response.content.filter((b): b is ClassifiedToolCall => b.type === "toolCall");
	if (toolCalls.length > 0) return { kind: "tool_calls", toolCalls };

	const text = response.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	if (!text.trim()) return { kind: "empty" };
	return { kind: "final", text };
}

/** Describes how a turn ended, for #terminateTurn. Absence means success. */
interface TurnFailure {
	errorType: ErrorType;
	message: string;
	retryability: Retryability;
	/** Preserve an original stream-provided error event (with its `details`) instead of reconstructing. */
	existingEvent?: TurnError;
}

/** Per-turn stable context threaded through the #doAsk state machine. */
interface TurnContext {
	readonly askSpan: import("@opentelemetry/api").Span;
	readonly turnId: string;
	readonly startedAt: number;
	readonly turnOverrides: { model: Model<Api>; maxIterations: number; thinking?: ThinkingConfig };
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
	/** Prior turns to seed the session with. Restores LLM context from previous conversation. */
	initialTurns?: TurnResult[];
	/** Last compaction summary from a prior session. Required for compaction continuity when restoring with initialTurns. */
	lastCompactionSummary?: string;
}

/**
 * A Session manages a conversation with an AI model about a code repository.
 *
 * Sessions provide:
 * - Multi-turn conversations with turn-based context
 * - Streaming responses via AskStream (AsyncIterable + .result())
 * - Tool execution (file reading, code search, etc.)
 * - Conversation branching via afterTurn
 * - Automatic release of forge-managed resources on close
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
/** Public session configuration snapshot, exposed via session.config. */
export interface PublicSessionConfig {
	readonly repo: RepoConfig;
	readonly model: ModelConfig;
	readonly systemPrompt: string;
	readonly maxIterations: number;
	readonly thinking?: ThinkingConfig;
	readonly compaction?: Partial<CompactionSettings>;
}

export class Session {
	/** Unique identifier for this session */
	readonly id: string;
	/** The repository this session is connected to */
	readonly repo: Repo;
	/** The session's immutable configuration */
	readonly config: PublicSessionConfig;

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
	#traceRoot?: AskTraceRoot;

	constructor(repo: Repo, config: SessionConfig, traceRoot?: AskTraceRoot) {
		this.id = randomUUID();
		this.repo = repo;
		this.config = {
			repo: { url: repo.url },
			model: { provider: String(config.model.provider), id: String(config.model.id) },
			systemPrompt: config.systemPrompt,
			maxIterations: config.maxIterations,
			thinking: config.thinking,
			compaction: config.compaction,
		};
		this.#config = config;
		this.#traceRoot = traceRoot;
		this.#logger = config.logger ?? consoleLogger;
		this.#stream = (config.stream ?? stream) as StreamFn;
		this.#streamSimple = (config.streamSimple ?? streamSimple) as StreamFn;
		this.#context = {
			systemPrompt: config.systemPrompt,
			messages: [],
			tools: config.tools,
		};

		if (config.initialTurns?.length) {
			const { messages, turnSnapshots } = reconstructContext(config.initialTurns);
			this.#context.messages = messages;
			this.#turns = [...config.initialTurns];
			this.#turnMessages = turnSnapshots;
			this.#compactionSummary = config.lastCompactionSummary;
		}
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
	ask(prompt: string, options?: AskOptions): AskStream {
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
	 * **This MUST be called when the caller is done with the session.** The root
	 * OTel "ask" span is started in `Client.connect()` and only ended here; if
	 * `close()` is never called (early return, thrown `ask()`, caller forgets,
	 * session is GC'd), the root span never terminates and the OTel SDK silently
	 * drops the entire trace tree on shutdown — every turn, generation, and
	 * tool span for this session is lost from your observability backend.
	 *
	 * Always pair `connect()` with `close()` via try/finally:
	 *
	 * ```ts
	 * const session = await client.connect(config);
	 * try {
	 *   for await (const ev of session.ask("...")) { ... }
	 * } finally {
	 *   await session.close();
	 * }
	 * ```
	 *
	 * Also releases the forge-managed resources associated with the session.
	 * The session cannot be used after closing. Safe to call multiple times.
	 */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;

		const cleanup = await cleanupRepo(this.repo);
		if (!cleanup.ok) this.#logger.error("session cleanup failed", cleanup.details);
		if (this.#traceRoot) {
			endRootAskSpan(this.#traceRoot.rootSpan);
		}
	}

	/** Get all completed turns in chronological order. */
	getTurns(): readonly TurnResult[] {
		return [...this.#turns];
	}

	/** Get the current compaction summary. Persist this alongside getTurns() for session restoration. */
	getCompactionSummary(): string | undefined {
		return this.#compactionSummary;
	}

	/** Get a specific turn by ID. Returns null if not found. */
	getTurn(id: string): TurnResult | null {
		return this.#turns.find((t) => t.id === id) ?? null;
	}

	async *#doAsk(
		prompt: string,
		prevPending: Promise<unknown>,
		onDone: () => void,
		options?: AskOptions,
	): AsyncGenerator<StreamEvent> {
		let askSpan: import("@opentelemetry/api").Span | undefined;
		let askSpanEnded = false;
		// Outer-scoped counters so the catch/finally safety net can read them
		// even if the main body bails before they reach #terminateTurn.
		const totalUsage: UsageAccumulator = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		let totalToolCalls = 0;

		try {
			await prevPending;

			if (options?.afterTurn) {
				const snapshot = this.#turnMessages.get(options.afterTurn);
				if (snapshot) {
					this.#context.messages = [...snapshot];
				}
			}

			// Pre-turn-start abort: yield only the error event (no turn_start/turn_end).
			if (options?.signal?.aborted) {
				yield { type: "error", errorType: "aborted", message: "Aborted", retryability: "no" };
				return;
			}

			const turnModel = options?.model
				? (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(options.model.provider, options.model.id)
				: this.#config.model;
			const turnMaxIterations = options?.maxIterations ?? this.#config.maxIterations;
			const turnThinking = options?.thinking ?? this.#config.thinking;
			const modelId = `${turnModel.provider}/${turnModel.id}`;
			const turnOverrides = { model: turnModel, maxIterations: turnMaxIterations, thinking: turnThinking };

			const turnId = randomUUID();
			const startedAt = Date.now();
			yield { type: "turn_start", turnId, prompt, timestamp: startedAt };

			// Start a per-turn span after turn_start yield. Sessions created through
			// Client.connect() attach this to the long-lived root ask span so connect
			// and later turns share one end-to-end trace. Direct Session() tests keep
			// the older per-turn root span behavior as a fallback.
			askSpan = this.#traceRoot
				? startAskTurnSpan(this.#traceRoot, {
						question: prompt,
						sessionId: this.id,
						repoUrl: this.repo.url,
						commitish: this.repo.commitish,
						model: modelId,
						systemPrompt: this.#context.systemPrompt,
					})
				: startAskSpan({
						question: prompt,
						sessionId: this.id,
						repoUrl: this.repo.url,
						commitish: this.repo.commitish,
						model: modelId,
						systemPrompt: this.#context.systemPrompt,
					});

			yield* this.#runCompaction(askSpan, prompt, turnModel);

			const ctx: TurnContext = { askSpan, turnId, startedAt, turnOverrides };
			let iterations = 0;

			for (let iteration = 0; iteration < turnMaxIterations; iteration++) {
				if (options?.signal?.aborted) {
					yield* this.#terminateTurn(ctx, iterations, totalUsage, totalToolCalls, {
						errorType: "aborted",
						message: "Aborted",
						retryability: "no",
					});
					askSpanEnded = true;
					return;
				}

				iterations = iteration + 1;
				yield { type: "iteration_start", index: iteration };

				const genSpan = startGenerationSpan(askSpan, {
					iteration: iterations,
					model: modelId,
					provider: String(turnModel.provider),
					messages: [...this.#context.messages],
				});

				const { streamFn, streamOptions } = this.#resolveStreamCall(turnThinking);
				const { events, response: getResponse } = processStreamToEvents(
					streamFn,
					turnModel,
					this.#context,
					streamOptions,
					turnModel.contextWindow,
				);

				let streamErrorEvent: TurnError | undefined;
				for await (const event of events) {
					if (event.type === "error") {
						streamErrorEvent = event;
						break;
					}
					yield event;
				}

				if (streamErrorEvent) {
					endGenerationSpanWithError(genSpan, streamErrorEvent.errorType, streamErrorEvent.message);
					yield* this.#terminateTurn(ctx, iterations, totalUsage, totalToolCalls, {
						errorType: streamErrorEvent.errorType,
						message: streamErrorEvent.message,
						retryability: streamErrorEvent.retryability,
						existingEvent: streamErrorEvent,
					});
					askSpanEnded = true;
					return;
				}

				const response = await getResponse();
				this.#context.messages.push(response);
				accumulateUsage(totalUsage, response.usage);

				const genSpanMetrics = {
					output: response.content,
					inputTokens: response.usage?.input ?? 0,
					outputTokens: response.usage?.output ?? 0,
					cacheReadTokens: response.usage?.cacheRead ?? 0,
					cacheCreationTokens: response.usage?.cacheWrite ?? 0,
					stopReason: response.stopReason,
				};

				const classification = classifyResponse(response);

				if (classification.kind === "empty") {
					const message = "Model returned an empty response";
					endGenerationSpanWithError(genSpan, "empty_response", message);
					yield* this.#terminateTurn(ctx, iterations, totalUsage, totalToolCalls, {
						errorType: "empty_response",
						message,
						retryability: "yes",
					});
					askSpanEnded = true;
					return;
				}

				if (classification.kind === "final") {
					endGenerationSpan(genSpan, genSpanMetrics);
					yield* this.#terminateTurn(ctx, iterations, totalUsage, totalToolCalls);
					askSpanEnded = true;
					return;
				}

				totalToolCalls += classification.toolCalls.length;
				endGenerationSpan(genSpan, genSpanMetrics);
				yield* this.#executeToolCalls(classification.toolCalls, genSpan);
			}

			yield* this.#terminateTurn(ctx, iterations, totalUsage, totalToolCalls, {
				errorType: "max_iterations",
				message: "Max iterations reached without a final answer.",
				retryability: "no",
			});
			askSpanEnded = true;
		} catch (error) {
			if (askSpan && !askSpanEnded) {
				endAskSpanWithError(askSpan, "internal_error", error);
				askSpanEnded = true;
			}
			if (error instanceof MegasthenesError) throw error;
			throw new MegasthenesError("internal_error", "Unexpected error during turn", {
				retryability: "no",
				details: error,
				cause: error,
			});
		} finally {
			if (askSpan && !askSpanEnded) {
				endAskSpan(askSpan, { toolCallCount: totalToolCalls, totalIterations: 0, usage: totalUsage });
			}
			onDone();
		}
	}

	/**
	 * Emit the terminal `error` (if any) and `turn_end` events for a turn and
	 * close the ask span consistently. Centralizing this is the sole reason the
	 * four end-of-turn code paths in #doAsk collapse into single call sites.
	 */
	*#terminateTurn(
		ctx: TurnContext,
		iterations: number,
		usage: UsageAccumulator,
		totalToolCalls: number,
		failure?: TurnFailure,
	): Generator<StreamEvent> {
		if (failure) {
			if (failure.existingEvent) {
				yield failure.existingEvent;
			} else {
				yield {
					type: "error",
					errorType: failure.errorType,
					message: failure.message,
					retryability: failure.retryability,
				};
			}
			endAskSpanWithError(ctx.askSpan, failure.errorType, failure.message);
		} else {
			endAskSpan(ctx.askSpan, { toolCallCount: totalToolCalls, totalIterations: iterations, usage });
		}
		yield {
			type: "turn_end",
			turnId: ctx.turnId,
			metadata: this.#buildTurnMetadata(iterations, ctx.startedAt, ctx.turnOverrides),
			usage: this.#buildTurnUsage(usage),
		};
	}

	/**
	 * Run the compaction step for a new turn and emit the `compaction` event
	 * when a compaction actually happens. On failure, swallows the error (a
	 * compaction failure must not abort the turn) but records it on the span.
	 */
	async *#runCompaction(
		askSpan: import("@opentelemetry/api").Span,
		prompt: string,
		turnModel: Model<Api>,
	): AsyncGenerator<StreamEvent> {
		const newQuestionMessage: Message = { role: "user", content: prompt, timestamp: Date.now() };
		const messagesWithQuestion = [...this.#context.messages, newQuestionMessage];

		const compactionSpan = startCompactionSpan(askSpan);
		try {
			const result = await maybeCompact(turnModel, messagesWithQuestion, this.#compactionSummary);
			if (result.wasCompacted) {
				this.#context.messages = result.messages;
				this.#compactionSummary = result.summary;
				endCompactionSpan(compactionSpan, {
					wasCompacted: true,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
				});
				yield {
					type: "compaction",
					summary: result.summary ?? "",
					firstKeptOrdinal: result.firstKeptOrdinal,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
					readFiles: result.readFiles,
					modifiedFiles: result.modifiedFiles,
				};
			} else {
				this.#context.messages.push(newQuestionMessage);
				endCompactionSpan(compactionSpan, { wasCompacted: false });
			}
		} catch (compactionError) {
			this.#context.messages.push(newQuestionMessage);
			endCompactionSpanWithError(compactionSpan, compactionError);
		}
	}

	#buildTurnMetadata(
		iterations: number,
		startedAt: number,
		turnOverrides: {
			model: Model<Api>;
			maxIterations: number;
			thinking?: ThinkingConfig;
		},
	): TurnMetadata {
		return {
			iterations,
			latencyMs: Date.now() - startedAt,
			model: { provider: String(turnOverrides.model.provider), id: String(turnOverrides.model.id) },
			repo: { url: this.repo.url, commitish: this.repo.commitish },
			config: {
				maxIterations: turnOverrides.maxIterations,
				thinkingConfig: turnOverrides.thinking,
			},
		};
	}

	#buildTurnUsage(raw: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	}): TokenUsage {
		return {
			inputTokens: raw.inputTokens,
			outputTokens: raw.outputTokens,
			totalTokens: raw.inputTokens + raw.outputTokens,
			cacheReadTokens: raw.cacheReadTokens,
			cacheWriteTokens: raw.cacheWriteTokens,
		};
	}

	async *#executeToolCalls(
		toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
		parentSpan: import("@opentelemetry/api").Span,
	): AsyncGenerator<StreamEvent> {
		const results = await Promise.all(
			toolCalls.map(async (call) => {
				const toolSpan = startToolSpan(parentSpan, {
					toolName: call.name,
					toolCallId: call.id,
					args: call.arguments,
				});
				const t0 = Date.now();
				try {
					const result = await this.#config.executeTool(call.name, call.arguments, this.repo.localPath);
					endToolSpan(toolSpan, result);
					return { text: result, isError: false, durationMs: Date.now() - t0 };
				} catch (error) {
					const errorText = formatToolExecutionError(call.name, error);
					endToolSpanWithError(toolSpan, error, errorText);
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

			// Use index-based ID to match tool_use_start/tool_use_end from the
			// stream processor (which uses String(contentIndex)). The context
			// message above keeps call.id for the LLM provider.
			yield {
				type: "tool_result",
				toolCallId: String(j),
				name: call.name,
				output: r.text,
				isError: r.isError,
				durationMs: r.durationMs,
			};
		}
	}
}
