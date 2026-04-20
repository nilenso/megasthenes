/**
 * Typed error class for errors thrown (not yielded) by the library.
 * Used for unrecoverable / unexpected errors in the catch path.
 */
import type { ErrorType, Retryability } from "./types";

export class MegasthenesError extends Error {
	/** Programmatic error type for switch/match handling. */
	readonly errorType: ErrorType;
	/** Whether retrying the same operation might succeed. */
	readonly retryability: Retryability;
	/** Raw error details from the provider or internal context (for logging/debugging). */
	readonly details?: unknown;

	constructor(
		errorType: ErrorType,
		message: string,
		options?: {
			retryability?: Retryability;
			details?: unknown;
			cause?: unknown;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = "MegasthenesError";
		this.errorType = errorType;
		this.retryability = options?.retryability ?? "unknown";
		this.details = options?.details;
	}
}
