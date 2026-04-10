import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import type { StreamEvent } from "./types";

// =============================================================================
// Types
// =============================================================================

/** Raw stream event from pi-ai (loosely typed) */
interface RawStreamEvent {
	type: string;
	delta?: string;
	contentIndex?: number;
	partial?: {
		content: Array<{ type: string; name?: string }>;
	};
	toolCall?: {
		name: string;
		arguments: Record<string, unknown>;
	};
	error?: unknown;
}

// =============================================================================
// Helper Functions
// =============================================================================

function extractErrorText(error: unknown): string {
	const err = error as { errorMessage?: string; content?: { type: string; text?: string }[] } | undefined;
	const firstTextBlock = err?.content?.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
	return err?.errorMessage || firstTextBlock?.text || "Unknown API error";
}

/**
 * Parse tool call delta event data.
 * Returns null if the event doesn't contain valid tool call info.
 */
function parseToolCallDelta(event: RawStreamEvent): {
	contentIndex: number;
	name: string;
	delta: string;
} | null {
	const contentIndex = event.contentIndex ?? 0;
	const partialToolCall = event.partial?.content[contentIndex];

	if (partialToolCall?.type === "toolCall" && partialToolCall.name) {
		return { contentIndex, name: partialToolCall.name, delta: event.delta ?? "" };
	}
	return null;
}

// =============================================================================
// Stream function type
// =============================================================================

/** Stream function signature that accepts both stream() and streamSimple(). */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: Record<string, unknown>,
) => AssistantMessageEventStream;

// =============================================================================
// Stream processor
// =============================================================================

/** Result of processStreamToEvents: an async generator of events plus access to the final response. */
export interface StreamToEventsResult {
	/** Async generator yielding StreamEvent objects. Must be fully consumed before calling response(). */
	events: AsyncGenerator<StreamEvent>;
	/** Returns the final AssistantMessage after the stream is fully consumed. */
	response: () => Promise<AssistantMessage>;
}

/**
 * Processes a pi-ai stream and yields StreamEvent objects.
 *
 * Returns an async generator that yields typed StreamEvent objects, plus
 * a response() accessor for the final AssistantMessage.
 *
 * Handles a single LLM iteration (one inference call). The session layer
 * wraps multiple iterations into a full turn.
 */
export function processStreamToEvents(
	streamFn: StreamFn,
	model: Model<Api>,
	context: Context,
	streamOptions?: Record<string, unknown>,
): StreamToEventsResult {
	let eventStream: AssistantMessageEventStream;

	async function* generate(): AsyncGenerator<StreamEvent> {
		const toolCallNames = new Map<number, string>();
		// Accumulate text and thinking deltas to emit completion events
		let thinkingAccum = "";
		let textAccum = "";
		let hasThinking = false;
		let hasText = false;

		try {
			eventStream = streamFn(model, context, streamOptions);

			for await (const rawEvent of eventStream) {
				const event = rawEvent as RawStreamEvent;

				switch (event.type) {
					case "thinking_delta": {
						const delta = event.delta ?? "";
						thinkingAccum += delta;
						hasThinking = true;
						yield { type: "thinking_delta", delta };
						break;
					}

					case "text_delta": {
						// If we accumulated thinking, emit the completion event before text starts
						if (hasThinking && thinkingAccum) {
							yield { type: "thinking", text: thinkingAccum };
							thinkingAccum = "";
						}
						const delta = event.delta ?? "";
						textAccum += delta;
						hasText = true;
						yield { type: "text_delta", delta };
						break;
					}

					case "toolcall_delta": {
						// Emit completion events for any accumulated content before tool calls
						if (hasThinking && thinkingAccum) {
							yield { type: "thinking", text: thinkingAccum };
							thinkingAccum = "";
						}
						if (hasText && textAccum) {
							yield { type: "text", text: textAccum };
							textAccum = "";
						}

						const parsed = parseToolCallDelta(event);
						if (parsed) {
							if (!toolCallNames.has(parsed.contentIndex)) {
								toolCallNames.set(parsed.contentIndex, parsed.name);
								yield { type: "tool_use_start", toolCallId: String(parsed.contentIndex), name: parsed.name };
							}
							yield {
								type: "tool_use_delta",
								toolCallId: String(parsed.contentIndex),
								name: parsed.name,
								delta: parsed.delta,
							};
						}
						break;
					}

					case "toolcall_end": {
						const contentIndex = event.contentIndex ?? 0;
						toolCallNames.delete(contentIndex);
						if (event.toolCall) {
							yield {
								type: "tool_use_end",
								toolCallId: String(contentIndex),
								name: event.toolCall.name,
								params: event.toolCall.arguments,
							};
						}
						break;
					}

					case "toolcall_start":
						// No useful info yet (name comes with first delta)
						break;

					case "error": {
						const errorText = extractErrorText(event.error);
						yield { type: "error", message: `API call failed: ${errorText}`, details: event.error };
						return;
					}

					default:
						// Unknown event types are silently ignored
						break;
				}
			}

			// Emit final completion events for any remaining accumulated content
			if (hasThinking && thinkingAccum) {
				yield { type: "thinking", text: thinkingAccum };
			}
			if (hasText && textAccum) {
				yield { type: "text", text: textAccum };
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			yield { type: "error", message: `API call failed: ${errorMessage}`, details: error };
		}
	}

	return {
		events: generate(),
		response: () => eventStream.result(),
	};
}
