import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { classifyProviderError, classifyThrownError, errorSource } from "../src/error-classification";

/** Helper to create a minimal AssistantMessage for testing. */
function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
		timestamp: Date.now(),
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "error",
		errorMessage: "Something went wrong",
		...overrides,
	} as AssistantMessage;
}

describe("classifyProviderError", () => {
	test("detects context overflow from Anthropic-style message", () => {
		const msg = makeAssistantMessage({
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
		});
		const result = classifyProviderError(msg);
		expect(result.errorType).toBe("context_overflow");
		expect(result.isRetryable).toBe(true);
	});

	test("detects context overflow from OpenAI-style message", () => {
		const msg = makeAssistantMessage({
			errorMessage: "This model's maximum context length is 128000 tokens but the request exceeds the context window",
		});
		const result = classifyProviderError(msg);
		expect(result.errorType).toBe("context_overflow");
		expect(result.isRetryable).toBe(true);
	});

	test("returns provider_error for generic error message", () => {
		const msg = makeAssistantMessage({
			errorMessage: "Internal server error",
		});
		const result = classifyProviderError(msg);
		expect(result.errorType).toBe("provider_error");
		expect(result.isRetryable).toBeNull();
	});

	test("returns provider_error when no error message", () => {
		const msg = makeAssistantMessage({ errorMessage: undefined });
		const result = classifyProviderError(msg);
		expect(result.errorType).toBe("provider_error");
		expect(result.isRetryable).toBeNull();
	});
});

describe("classifyThrownError", () => {
	test("detects ECONNREFUSED as network_error", () => {
		const result = classifyThrownError(new Error("connect ECONNREFUSED 127.0.0.1:443"));
		expect(result.errorType).toBe("network_error");
		expect(result.isRetryable).toBe(true);
	});

	test("detects fetch failed as network_error", () => {
		const result = classifyThrownError(new TypeError("fetch failed"));
		expect(result.errorType).toBe("network_error");
		expect(result.isRetryable).toBe(true);
	});

	test("detects ETIMEDOUT as network_error", () => {
		const result = classifyThrownError(new Error("connect ETIMEDOUT 1.2.3.4:443"));
		expect(result.errorType).toBe("network_error");
		expect(result.isRetryable).toBe(true);
	});

	test("detects ENOTFOUND as network_error", () => {
		const result = classifyThrownError(new Error("getaddrinfo ENOTFOUND api.example.com"));
		expect(result.errorType).toBe("network_error");
		expect(result.isRetryable).toBe(true);
	});

	test("detects ECONNRESET as network_error", () => {
		const result = classifyThrownError(new Error("read ECONNRESET"));
		expect(result.errorType).toBe("network_error");
		expect(result.isRetryable).toBe(true);
	});

	test("detects socket hang up as network_error", () => {
		const result = classifyThrownError(new Error("socket hang up"));
		expect(result.errorType).toBe("network_error");
		expect(result.isRetryable).toBe(true);
	});

	test("returns provider_error for non-network error", () => {
		const result = classifyThrownError(new Error("Invalid JSON in response"));
		expect(result.errorType).toBe("provider_error");
		expect(result.isRetryable).toBeNull();
	});

	test("handles non-Error values", () => {
		const result = classifyThrownError("string error");
		expect(result.errorType).toBe("provider_error");
		expect(result.isRetryable).toBeNull();
	});
});

describe("errorSource", () => {
	test("library errors", () => {
		expect(errorSource("aborted")).toBe("library");
		expect(errorSource("max_iterations")).toBe("library");
		expect(errorSource("internal_error")).toBe("library");
		expect(errorSource("clone_failed")).toBe("library");
		expect(errorSource("invalid_commitish")).toBe("library");
		expect(errorSource("invalid_config")).toBe("library");
	});

	test("provider errors", () => {
		expect(errorSource("context_overflow")).toBe("provider");
		expect(errorSource("provider_error")).toBe("provider");
		expect(errorSource("empty_response")).toBe("provider");
		expect(errorSource("network_error")).toBe("provider");
	});
});
