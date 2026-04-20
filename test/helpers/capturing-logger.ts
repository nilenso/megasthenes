import type { Logger } from "../../src/logger";

export interface CapturedError {
	label: string;
	payload: unknown;
}

/**
 * Logger that records each call structurally instead of formatting into strings.
 *
 * Tests can assert on the exact `(label, payload)` passed to `logger.error(...)`
 * without substring-matching or JSON-parsing. Warn/log/info/debug are stored as
 * pre-formatted strings in `logs` since those paths don't need structural access
 * in current tests.
 */
export function createCapturingLogger(): {
	logger: Logger;
	logs: string[];
	errors: CapturedError[];
} {
	const logs: string[] = [];
	const errors: CapturedError[] = [];
	return {
		logs,
		errors,
		logger: {
			error(label, payload) {
				errors.push({ label, payload });
			},
			warn(label, content) {
				logs.push(`WARN ${label}: ${content}`);
			},
			log(label, content) {
				logs.push(`${label}: ${content}`);
			},
			info(label, content) {
				logs.push(`${label}: ${content}`);
			},
			debug(label, content) {
				logs.push(`DEBUG ${label}: ${content}`);
			},
		},
	};
}
