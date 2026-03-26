import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import type { OnProgress, ProgressEvent } from "./session";

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
