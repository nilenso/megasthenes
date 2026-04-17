/**
 * Error classification for megasthenes.
 *
 * Centralizes all error detection heuristics so they are testable
 * independently and don't pollute session.ts or stream-processor.ts.
 */
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { isContextOverflow } from "@mariozechner/pi-ai";
import type { ErrorType } from "./types";

/** Heuristic patterns for network-level JavaScript exceptions. */
const NETWORK_ERROR_PATTERNS = [
	/fetch failed/i,
	/ECONNREFUSED/,
	/ENOTFOUND/,
	/ETIMEDOUT/,
	/ECONNRESET/,
	/socket hang up/i,
	/network request failed/i,
];

export interface ClassifiedError {
	errorType: ErrorType;
	isRetryable: boolean | null;
}

/**
 * Classify a provider stream error event.
 * Called when pi-ai emits { type: "error", error: AssistantMessage }.
 */
export function classifyProviderError(assistantMessage: AssistantMessage, contextWindow?: number): ClassifiedError {
	if (isContextOverflow(assistantMessage, contextWindow)) {
		return { errorType: "context_overflow", isRetryable: true };
	}
	return { errorType: "provider_error", isRetryable: null };
}

/**
 * Classify a thrown exception caught during streaming.
 * Called from the catch block in stream-processor.
 */
export function classifyThrownError(error: unknown): ClassifiedError {
	const message = error instanceof Error ? error.message : String(error);
	if (NETWORK_ERROR_PATTERNS.some((p) => p.test(message))) {
		return { errorType: "network_error", isRetryable: true };
	}
	return { errorType: "provider_error", isRetryable: null };
}

/**
 * Derive error source from error code.
 * Library errors originate from megasthenes itself; provider errors from the LLM.
 */
export function errorSource(errorType: ErrorType): "provider" | "library" {
	switch (errorType) {
		case "aborted":
		case "max_iterations":
		case "internal_error":
		case "clone_failed":
		case "invalid_commitish":
		case "invalid_config":
			return "library";
		case "context_overflow":
		case "provider_error":
		case "empty_response":
		case "network_error":
			return "provider";
	}
}
