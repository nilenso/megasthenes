/**
 * Typed error class for errors thrown (not yielded) by the library.
 * Used for unrecoverable / unexpected errors in the catch path.
 */
import type { ErrorType } from "./types";

export class MegasthenesError extends Error {
	readonly code: ErrorType;
	readonly isRetryable: boolean | null;
	readonly details?: unknown;

	constructor(
		code: ErrorType,
		message: string,
		options?: {
			isRetryable?: boolean | null;
			details?: unknown;
			cause?: unknown;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = "MegasthenesError";
		this.code = code;
		this.isRetryable = options?.isRetryable ?? null;
		this.details = options?.details;
	}
}
