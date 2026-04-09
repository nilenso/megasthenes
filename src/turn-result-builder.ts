/**
 * Reduces a sequence of StreamEvent objects into a TurnResult.
 *
 * This is a stateful accumulator: feed it events via process(), then
 * call build() to get the final immutable TurnResult.
 */

import type {
	StreamEvent,
	TokenUsage,
	ToolCall,
	TurnMetadata,
	TurnResult,
} from "./types";

/** Mutable state for a tool call being assembled from stream events. */
interface PendingToolCall {
	id: string;
	name: string;
	params: Record<string, unknown>;
	output: string;
	isError: boolean;
	durationMs: number;
	complete: boolean;
}

export class TurnResultBuilder {
	#id = "";
	#prompt = "";
	#textParts: string[] = [];
	#thinkingParts: string[] = [];
	#thinkingSummaryParts: string[] = [];
	#hasThinking = false;
	#hasThinkingSummary = false;
	#toolCalls: PendingToolCall[] = [];
	#pendingTools = new Map<string, PendingToolCall>();
	#usage: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	#error: { message: string; details?: unknown } | null = null;
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
				break;

			case "thinking_delta":
				this.#hasThinking = true;
				this.#thinkingParts.push(event.delta);
				break;

			case "thinking":
				this.#hasThinking = true;
				// The complete text replaces any accumulated deltas for this block
				// (deltas already captured the same content incrementally)
				break;

			case "thinking_summary_delta":
				this.#hasThinkingSummary = true;
				this.#thinkingSummaryParts.push(event.delta);
				break;

			case "thinking_summary":
				this.#hasThinkingSummary = true;
				break;

			case "text_delta":
				this.#textParts.push(event.delta);
				break;

			case "text":
				// Complete text block — deltas already accumulated the content
				break;

			case "tool_use_start": {
				const pending: PendingToolCall = {
					id: event.toolCallId,
					name: event.name,
					params: {},
					output: "",
					isError: false,
					durationMs: 0,
					complete: false,
				};
				this.#pendingTools.set(event.toolCallId, pending);
				break;
			}

			case "tool_use_delta":
				// Argument streaming — not needed for the reduced result
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
				if (pending) {
					pending.output = event.output;
					pending.isError = event.isError;
					pending.durationMs = event.durationMs;
					pending.complete = true;
					this.#toolCalls.push(pending);
					this.#pendingTools.delete(event.toolCallId);
				} else {
					// tool_result without a prior tool_use_start — create a standalone record
					this.#toolCalls.push({
						id: event.toolCallId,
						name: event.name,
						params: {},
						output: event.output,
						isError: event.isError,
						durationMs: event.durationMs,
						complete: true,
					});
				}
				break;
			}

			case "compaction":
				// Compaction is informational — no fields on TurnResult
				break;

			case "error":
				this.#error = { message: event.message, details: event.details };
				break;
		}
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
		const completedToolCalls: ToolCall[] = this.#toolCalls.map((tc) => ({
			id: tc.id,
			name: tc.name,
			params: tc.params,
			output: tc.output,
			isError: tc.isError,
			durationMs: tc.durationMs,
		}));

		const defaultMetadata: TurnMetadata = {
			iterations: 0,
			latencyMs: this.#endedAt > 0 ? this.#endedAt - this.#startedAt : 0,
			model: { provider: "", id: "" },
			links: { total: 0, invalid: [] },
			repo: { url: "", commitish: "" },
			config: { maxIterations: 0 },
		};

		return {
			id: this.#id,
			prompt: this.#prompt,
			text: this.#textParts.join(""),
			thinking: this.#hasThinking ? this.#thinkingParts.join("") : null,
			thinkingSummary: this.#hasThinkingSummary ? this.#thinkingSummaryParts.join("") : null,
			toolCalls: completedToolCalls,
			usage: { ...this.#usage },
			metadata: this.#metadata ?? defaultMetadata,
			error: this.#error,
			startedAt: this.#startedAt,
			endedAt: this.#endedAt || Date.now(),
		};
	}
}
