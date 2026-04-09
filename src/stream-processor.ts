import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import type { OnProgress, ProgressEvent } from "./session";
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

/** Successful stream processing result */
export interface StreamSuccess {
	ok: true;
	/** The completed assistant message */
	response: AssistantMessage;
}

/** Failed stream processing result */
export interface StreamError {
	ok: false;
	/** Human-readable error message */
	error: string;
	/** Raw error details for logging */
	errorDetails?: unknown;
}

/**
 * Result of processing an AI model stream.
 * Use `outcome.ok` to discriminate between success and error.
 */
export type StreamOutcome = StreamSuccess | StreamError;

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

/**
 * Maps a raw stream event to a ProgressEvent.
 * Returns the progress event to emit, or an error if the stream errored.
 */
function mapStreamEvent(
	event: RawStreamEvent,
	toolCallNames: Map<number, string>,
): { progress?: ProgressEvent; error?: { text: string; details: unknown } } {
	switch (event.type) {
		case "thinking_delta":
			return { progress: { type: "thinking_delta", delta: event.delta ?? "" } };

		case "text_delta":
			return { progress: { type: "text_delta", delta: event.delta ?? "" } };

		case "toolcall_start":
			// We don't have the name yet, no event to emit
			return {};

		case "toolcall_delta": {
			// Note: tool_start is emitted by handleStreamEvent which can emit multiple events
			// This function only returns tool_delta; tool_start tracking happens in handleStreamEvent
			const parsed = parseToolCallDelta(event);
			if (parsed) {
				return { progress: { type: "tool_delta", name: parsed.name, delta: parsed.delta } };
			}
			return {};
		}

		case "toolcall_end": {
			const contentIndex = event.contentIndex ?? 0;
			toolCallNames.delete(contentIndex);
			if (event.toolCall) {
				return { progress: { type: "tool_end", name: event.toolCall.name, arguments: event.toolCall.arguments } };
			}
			return {};
		}

		case "error": {
			const errorText = extractErrorText(event.error);
			return { error: { text: errorText, details: event.error } };
		}

		default:
			return {};
	}
}

/**
 * Processes a stream event, emitting progress events and handling errors.
 * Returns an error result if the stream errored, otherwise null.
 */
function handleStreamEvent(
	event: RawStreamEvent,
	toolCallNames: Map<number, string>,
	onProgress?: OnProgress,
): { text: string; details: unknown } | null {
	// Special handling for toolcall_delta to emit tool_start first if needed
	if (event.type === "toolcall_delta") {
		const parsed = parseToolCallDelta(event);
		if (parsed) {
			if (!toolCallNames.has(parsed.contentIndex)) {
				toolCallNames.set(parsed.contentIndex, parsed.name);
				onProgress?.({ type: "tool_start", name: parsed.name, arguments: {} });
			}
			onProgress?.({ type: "tool_delta", name: parsed.name, delta: parsed.delta });
		}
		return null;
	}

	const result = mapStreamEvent(event, toolCallNames);

	if (result.error) {
		return result.error;
	}

	if (result.progress) {
		onProgress?.(result.progress);
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
// Main Function
// =============================================================================

/**
 * Processes a stream from the AI model, emitting progress events and returning the outcome.
 *
 * @param streamFn - The stream function to use (injectable for testing)
 * @param model - The model to use
 * @param context - The conversation context
 * @param onProgress - Optional callback for progress events (called in real-time)
 * @returns StreamOutcome - either success with response, or error with details
 */
export async function processStream(
	streamFn: StreamFn,
	model: Model<Api>,
	context: Context,
	onProgress?: OnProgress,
	streamOptions?: Record<string, unknown>,
): Promise<StreamOutcome> {
	const toolCallNames = new Map<number, string>();

	try {
		const eventStream = streamFn(model, context, streamOptions);

		for await (const event of eventStream) {
			const error = handleStreamEvent(event as RawStreamEvent, toolCallNames, onProgress);
			if (error) {
				return {
					ok: false,
					error: `API call failed: ${error.text}`,
					errorDetails: error.details,
				};
			}
		}

		return {
			ok: true,
			response: await eventStream.result(),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `API call failed: ${errorMessage}`,
			errorDetails: error,
		};
	}
}

// =============================================================================
// StreamEvent-based processor (new API)
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
 * This is the new-API equivalent of processStream(). Instead of using a callback,
 * it returns an async generator that yields typed StreamEvent objects, plus
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
