import { describe, expect, test } from "bun:test";
import { TurnResultBuilder } from "../src/turn-result-builder";
import type { StreamEvent, TurnMetadata } from "../src/types";

function makeMetadata(overrides?: Partial<TurnMetadata>): TurnMetadata {
	return {
		iterations: 1,
		latencyMs: 100,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		repo: { url: "https://github.com/test/repo", commitish: "abc123" },
		config: { maxIterations: 20 },
		...overrides,
	};
}

/** Feed a sequence of events into a builder and return the result. */
function buildFromEvents(events: StreamEvent[]) {
	const builder = new TurnResultBuilder();
	for (const event of events) {
		builder.process(event);
	}
	return builder.build();
}

describe("TurnResultBuilder", () => {
	describe("basic turn lifecycle", () => {
		test("empty event sequence produces sensible defaults", () => {
			const result = buildFromEvents([]);

			expect(result.id).toBe("");
			expect(result.prompt).toBe("");
			expect(result.steps).toEqual([]);
			expect(result.error).toBeNull();
			expect(result.usage.totalTokens).toBe(0);
		});

		test("turn_start sets id, prompt, and startedAt", () => {
			const result = buildFromEvents([{ type: "turn_start", turnId: "t-1", prompt: "Hello", timestamp: 1000 }]);

			expect(result.id).toBe("t-1");
			expect(result.prompt).toBe("Hello");
			expect(result.startedAt).toBe(1000);
		});

		test("turn_end sets metadata and endedAt", () => {
			const metadata = makeMetadata();
			const result = buildFromEvents([
				{ type: "turn_start", turnId: "t-1", prompt: "Hello", timestamp: 1000 },
				{ type: "turn_end", turnId: "t-1", metadata },
			]);

			expect(result.metadata).toEqual(metadata);
			expect(result.endedAt).toBeGreaterThan(0);
		});
	});

	describe("text steps", () => {
		test("text completion event becomes a text step", () => {
			const result = buildFromEvents([
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
				{ type: "text", text: "Hello world" },
			]);

			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toEqual({ type: "text", text: "Hello world", role: "assistant" });
		});

		test("text_delta events do not produce steps (intermediate)", () => {
			const result = buildFromEvents([{ type: "text_delta", delta: "partial" }]);

			expect(result.steps).toEqual([]);
		});

		test("multiple text blocks across iterations produce multiple steps", () => {
			const result = buildFromEvents([
				{ type: "text", text: "Part 1" },
				{ type: "text", text: "Part 2" },
			]);

			expect(result.steps).toHaveLength(2);
			expect(result.steps[0]).toEqual({ type: "text", text: "Part 1", role: "assistant" });
			expect(result.steps[1]).toEqual({ type: "text", text: "Part 2", role: "assistant" });
		});
	});

	describe("thinking steps", () => {
		test("thinking completion event becomes a thinking step", () => {
			const result = buildFromEvents([
				{ type: "thinking_delta", delta: "Let me " },
				{ type: "thinking_delta", delta: "reason" },
				{ type: "thinking", text: "Let me reason" },
			]);

			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toEqual({ type: "thinking", text: "Let me reason" });
		});

		test("thinking_delta events do not produce steps", () => {
			const result = buildFromEvents([{ type: "thinking_delta", delta: "partial" }]);

			expect(result.steps).toEqual([]);
		});
	});

	describe("thinking summary steps", () => {
		test("thinking_summary completion event becomes a step", () => {
			const result = buildFromEvents([
				{ type: "thinking_summary_delta", delta: "Summary " },
				{ type: "thinking_summary_delta", delta: "here" },
				{ type: "thinking_summary", text: "Summary here" },
			]);

			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toEqual({ type: "thinking_summary", text: "Summary here" });
		});
	});

	describe("tool call steps", () => {
		test("tool_use_start -> tool_use_end -> tool_result produces a tool_call step", () => {
			const result = buildFromEvents([
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_delta", toolCallId: "tc-1", name: "rg", delta: '{"pattern":"test"}' },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "test" } },
				{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "match found", isError: false, durationMs: 42 },
			]);

			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toEqual({
				type: "tool_call",
				id: "tc-1",
				name: "rg",
				params: { pattern: "test" },
				output: "match found",
				isError: false,
				durationMs: 42,
			});
		});

		test("failed tool call has isError=true", () => {
			const result = buildFromEvents([
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "test" } },
				{
					type: "tool_result",
					toolCallId: "tc-1",
					name: "rg",
					output: "command not found",
					isError: true,
					durationMs: 5,
				},
			]);

			const step = result.steps[0] as (typeof result.steps)[0];
			expect(step.type).toBe("tool_call");
			if (step.type === "tool_call") {
				expect(step.isError).toBe(true);
				expect(step.output).toBe("command not found");
			}
		});

		test("multiple tool calls produce separate steps in order", () => {
			const result = buildFromEvents([
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_start", toolCallId: "tc-2", name: "fd" },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "a" } },
				{ type: "tool_use_end", toolCallId: "tc-2", name: "fd", params: { pattern: "b" } },
				{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "r1", isError: false, durationMs: 10 },
				{ type: "tool_result", toolCallId: "tc-2", name: "fd", output: "r2", isError: false, durationMs: 20 },
			]);

			const toolSteps = result.steps.filter((s) => s.type === "tool_call");
			expect(toolSteps).toHaveLength(2);
			expect((toolSteps[0] as { name: string }).name).toBe("rg");
			expect((toolSteps[1] as { name: string }).name).toBe("fd");
		});

		test("tool_result without prior tool_use_start creates standalone step", () => {
			const result = buildFromEvents([
				{ type: "tool_result", toolCallId: "tc-orphan", name: "rg", output: "result", isError: false, durationMs: 5 },
			]);

			expect(result.steps).toHaveLength(1);
			const step = result.steps[0] as (typeof result.steps)[0];
			expect(step.type).toBe("tool_call");
			if (step.type === "tool_call") {
				expect(step.id).toBe("tc-orphan");
				expect(step.name).toBe("rg");
			}
		});
	});

	describe("step ordering", () => {
		test("steps preserve chronological order across types", () => {
			const result = buildFromEvents([
				{ type: "thinking", text: "reasoning" },
				{ type: "text", text: "I'll search" },
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: {} },
				{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "found", isError: false, durationMs: 10 },
				{ type: "text", text: "Here's the answer" },
			]);

			expect(result.steps.map((s) => s.type)).toEqual(["thinking", "text", "tool_call", "text"]);
		});
	});

	describe("iteration tracking", () => {
		test("addIterationStart() adds an iteration_start step", () => {
			const builder = new TurnResultBuilder();
			builder.addIterationStart(0);
			builder.process({ type: "text", text: "response" });
			builder.addIterationStart(1);

			const result = builder.build();
			const iterSteps = result.steps.filter((s) => s.type === "iteration_start");
			expect(iterSteps).toHaveLength(2);
			expect(iterSteps[0]).toEqual({ type: "iteration_start", index: 0 });
			expect(iterSteps[1]).toEqual({ type: "iteration_start", index: 1 });
		});
	});

	describe("compaction steps", () => {
		test("compaction event becomes a compaction step", () => {
			const result = buildFromEvents([
				{
					type: "compaction",
					summary: "summarized",
					tokensBefore: 100000,
					tokensAfter: 20000,
					firstKeptOrdinal: 3,
					readFiles: [],
					modifiedFiles: [],
				},
			]);

			expect(result.steps).toHaveLength(1);
			expect(result.steps[0]).toEqual({
				type: "compaction",
				summary: "summarized",
				tokensBefore: 100000,
				tokensAfter: 20000,
			});
		});
	});

	describe("error handling", () => {
		test("error event sets .error on the result and adds an error step", () => {
			const result = buildFromEvents([
				{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
				{
					type: "error",
					errorType: "provider_error",
					message: "API call failed",
					isRetryable: null,
					details: { code: 500 },
				},
			]);

			expect(result.error).not.toBeNull();
			expect(result.error?.errorType).toBe("provider_error");
			expect(result.error?.message).toBe("API call failed");
			expect(result.error?.isRetryable).toBeNull();
			expect(result.error?.details).toEqual({ code: 500 });

			const errorSteps = result.steps.filter((s) => s.type === "error");
			expect(errorSteps).toHaveLength(1);
			expect(errorSteps[0]).toEqual({
				type: "error",
				errorType: "provider_error",
				source: "provider",
				message: "API call failed",
				isRetryable: null,
				details: { code: 500 },
			});
		});

		test("setError() sets turn-level error", () => {
			const builder = new TurnResultBuilder();
			builder.setError("max_iterations", "Max iterations reached", false);

			const result = builder.build();
			expect(result.error).toEqual({
				errorType: "max_iterations",
				message: "Max iterations reached",
				isRetryable: false,
			});

			const errorSteps = result.steps.filter((s) => s.type === "error");
			expect(errorSteps).toHaveLength(1);
			if (errorSteps[0]?.type === "error") {
				expect(errorSteps[0].errorType).toBe("max_iterations");
				expect(errorSteps[0].source).toBe("library");
			}
		});

		test("error with preceding text preserves both as steps", () => {
			const result = buildFromEvents([
				{ type: "text", text: "partial" },
				{ type: "error", errorType: "provider_error", message: "interrupted", isRetryable: null },
			]);

			expect(result.steps).toHaveLength(2);
			expect(result.steps[0]?.type).toBe("text");
			expect(result.steps[1]?.type).toBe("error");
			expect(result.error).not.toBeNull();
		});
	});

	describe("usage accumulation", () => {
		test("addUsage() accumulates token counts", () => {
			const builder = new TurnResultBuilder();
			builder.addUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
			builder.addUsage({ inputTokens: 200, outputTokens: 30, totalTokens: 230, cacheReadTokens: 10 });

			const result = builder.build();
			expect(result.usage.inputTokens).toBe(300);
			expect(result.usage.outputTokens).toBe(80);
			expect(result.usage.totalTokens).toBe(380);
			expect(result.usage.cacheReadTokens).toBe(10);
			expect(result.usage.cacheWriteTokens).toBe(0);
		});
	});
});
