/**
 * Reduces a sequence of StreamEvent objects into a TurnResult.
 *
 * This is a stateful accumulator: feed it events via process(), then
 * call build() to get the final immutable TurnResult.
 *
 * The builder accumulates Steps — the ordered record of everything the
 * agent did during the turn.
 */

import { errorSource } from "./error-classification";
import type { ErrorType, Step, StreamEvent, TokenUsage, TurnMetadata, TurnResult } from "./types";

/** Mutable state for a tool call being assembled from stream events. */
interface PendingToolCall {
	id: string;
	name: string;
	params: Record<string, unknown>;
}

export class TurnResultBuilder {
	#id = "";
	#prompt = "";
	#steps: Step[] = [];
	#pendingTools = new Map<string, PendingToolCall>();
	#usage: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	#error: { errorType: ErrorType; message: string; isRetryable: boolean | null; details?: unknown } | null = null;
	#startedAt = 0;
	#endedAt = 0;
	#metadata: TurnMetadata | null = null;

	/** Process a single StreamEvent. */
	process(event: StreamEvent): void {
		switch (event.type) {
			case "turn_start":
				this.#id = event.turnId;
				this.#prompt = event.prompt;
				this.#startedAt = event.timestamp;
				break;

			case "turn_end":
				this.#endedAt = Date.now();
				this.#metadata = event.metadata;
				if (event.usage) {
					this.#usage = {
						inputTokens: event.usage.inputTokens,
						outputTokens: event.usage.outputTokens,
						totalTokens: event.usage.totalTokens,
						cacheReadTokens: event.usage.cacheReadTokens,
						cacheWriteTokens: event.usage.cacheWriteTokens,
					};
				}
				break;

			// --- Content completion events become steps ---

			case "thinking":
				this.#steps.push({ type: "thinking", text: event.text });
				break;

			case "thinking_summary":
				this.#steps.push({ type: "thinking_summary", text: event.text });
				break;

			case "text":
				this.#steps.push({ type: "text", text: event.text, role: "assistant" });
				break;

			// --- Iteration lifecycle ---

			case "iteration_start":
				this.#steps.push({ type: "iteration_start", index: event.index });
				break;

			// --- Streaming deltas are not steps (they're intermediate) ---

			case "thinking_delta":
			case "thinking_summary_delta":
			case "text_delta":
			case "tool_use_delta":
				break;

			// --- Tool lifecycle ---

			case "tool_use_start":
				this.#pendingTools.set(event.toolCallId, {
					id: event.toolCallId,
					name: event.name,
					params: {},
				});
				break;

			case "tool_use_end": {
				const pending = this.#pendingTools.get(event.toolCallId);
				if (pending) {
					pending.params = event.params;
				}
				break;
			}

			case "tool_result": {
				const pending = this.#pendingTools.get(event.toolCallId);
				this.#steps.push({
					type: "tool_call",
					id: pending?.id ?? event.toolCallId,
					name: event.name,
					params: pending?.params ?? {},
					output: event.output,
					isError: event.isError,
					durationMs: event.durationMs,
				});
				if (pending) this.#pendingTools.delete(event.toolCallId);
				break;
			}

			// --- Context management ---

			case "compaction":
				this.#steps.push({
					type: "compaction",
					summary: event.summary,
					tokensBefore: event.tokensBefore,
					tokensAfter: event.tokensAfter,
				});
				break;

			// --- Errors ---

			case "error":
				this.#error = {
					errorType: event.errorType,
					message: event.message,
					isRetryable: event.isRetryable,
					details: event.details,
				};
				this.#steps.push({
					type: "error",
					errorType: event.errorType,
					source: errorSource(event.errorType),
					message: event.message,
					isRetryable: event.isRetryable,
					details: event.details,
				});
				break;
		}
	}

	/** Add an iteration_start step (called by the session layer). */
	addIterationStart(index: number): void {
		this.#steps.push({ type: "iteration_start", index });
	}

	/** Set the turn error (called by the session layer). */
	setError(errorType: ErrorType, message: string, isRetryable: boolean | null, details?: unknown): void {
		this.#error = { errorType, message, isRetryable, details };
		this.#steps.push({
			type: "error",
			errorType,
			source: errorSource(errorType),
			message,
			isRetryable,
			details,
		});
	}

	/** Accumulate token usage (called by the session layer after each iteration). */
	addUsage(usage: Partial<TokenUsage>): void {
		this.#usage = {
			inputTokens: this.#usage.inputTokens + (usage.inputTokens ?? 0),
			outputTokens: this.#usage.outputTokens + (usage.outputTokens ?? 0),
			totalTokens: this.#usage.totalTokens + (usage.totalTokens ?? 0),
			cacheReadTokens: this.#usage.cacheReadTokens + (usage.cacheReadTokens ?? 0),
			cacheWriteTokens: this.#usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
		};
	}

	/** Build the final immutable TurnResult. */
	build(): TurnResult {
		const defaultMetadata: TurnMetadata = {
			iterations: 0,
			latencyMs: this.#endedAt > 0 ? this.#endedAt - this.#startedAt : 0,
			model: { provider: "", id: "" },
			repo: { url: "", commitish: "" },
			config: { maxIterations: 0 },
		};

		return {
			id: this.#id,
			prompt: this.#prompt,
			steps: [...this.#steps],
			usage: { ...this.#usage },
			metadata: this.#metadata ?? defaultMetadata,
			error: this.#error,
			startedAt: this.#startedAt,
			endedAt: this.#endedAt || Date.now(),
		};
	}
}
