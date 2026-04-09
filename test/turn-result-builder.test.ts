import { describe, expect, test } from "bun:test";
import { TurnResultBuilder } from "../src/turn-result-builder";
import type { StreamEvent, TurnMetadata } from "../src/types";

function makeMetadata(overrides?: Partial<TurnMetadata>): TurnMetadata {
	return {
		iterations: 1,
		latencyMs: 100,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		links: { total: 0, invalid: [] },
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
			expect(result.text).toBe("");
			expect(result.thinking).toBeNull();
			expect(result.thinkingSummary).toBeNull();
			expect(result.toolCalls).toEqual([]);
			expect(result.error).toBeNull();
			expect(result.usage.totalTokens).toBe(0);
		});

		test("turn_start sets id, prompt, and startedAt", () => {
			const result = buildFromEvents([
				{ type: "turn_start", turnId: "t-1", prompt: "Hello", timestamp: 1000 },
			]);

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

	describe("text accumulation", () => {
		test("text_delta events accumulate into .text", () => {
			const result = buildFromEvents([
				{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
				{ type: "text", text: "Hello world" },
				{ type: "turn_end", turnId: "t-1", metadata: makeMetadata() },
			]);

			expect(result.text).toBe("Hello world");
		});

		test("multiple text blocks across iterations concatenate", () => {
			const result = buildFromEvents([
				{ type: "text_delta", delta: "Part 1" },
				{ type: "text", text: "Part 1" },
				// second iteration
				{ type: "text_delta", delta: " Part 2" },
				{ type: "text", text: " Part 2" },
			]);

			expect(result.text).toBe("Part 1 Part 2");
		});
	});

	describe("thinking accumulation", () => {
		test("thinking_delta events accumulate into .thinking", () => {
			const result = buildFromEvents([
				{ type: "thinking_delta", delta: "Let me " },
				{ type: "thinking_delta", delta: "reason" },
				{ type: "thinking", text: "Let me reason" },
			]);

			expect(result.thinking).toBe("Let me reason");
		});

		test("thinking is null when no thinking events occur", () => {
			const result = buildFromEvents([
				{ type: "text_delta", delta: "answer" },
				{ type: "text", text: "answer" },
			]);

			expect(result.thinking).toBeNull();
		});
	});

	describe("thinking summary accumulation", () => {
		test("thinking_summary_delta events accumulate into .thinkingSummary", () => {
			const result = buildFromEvents([
				{ type: "thinking_summary_delta", delta: "Summary " },
				{ type: "thinking_summary_delta", delta: "here" },
				{ type: "thinking_summary", text: "Summary here" },
			]);

			expect(result.thinkingSummary).toBe("Summary here");
		});

		test("thinkingSummary is null when no summary events occur", () => {
			const result = buildFromEvents([
				{ type: "thinking_delta", delta: "thinking" },
				{ type: "thinking", text: "thinking" },
			]);

			expect(result.thinkingSummary).toBeNull();
		});
	});

	describe("tool call lifecycle", () => {
		test("tool_use_start -> tool_use_end -> tool_result builds a ToolCall", () => {
			const result = buildFromEvents([
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_delta", toolCallId: "tc-1", name: "rg", delta: '{"pattern":"test"}' },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "test" } },
				{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "match found", isError: false, durationMs: 42 },
			]);

			expect(result.toolCalls).toHaveLength(1);
			const tc = result.toolCalls[0]!;
			expect(tc.id).toBe("tc-1");
			expect(tc.name).toBe("rg");
			expect(tc.params).toEqual({ pattern: "test" });
			expect(tc.output).toBe("match found");
			expect(tc.isError).toBe(false);
			expect(tc.durationMs).toBe(42);
		});

		test("failed tool call has isError=true", () => {
			const result = buildFromEvents([
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "test" } },
				{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "command not found", isError: true, durationMs: 5 },
			]);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0]!.isError).toBe(true);
			expect(result.toolCalls[0]!.output).toBe("command not found");
		});

		test("multiple tool calls are tracked independently", () => {
			const result = buildFromEvents([
				{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
				{ type: "tool_use_start", toolCallId: "tc-2", name: "fd" },
				{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "a" } },
				{ type: "tool_use_end", toolCallId: "tc-2", name: "fd", params: { pattern: "b" } },
				{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "r1", isError: false, durationMs: 10 },
				{ type: "tool_result", toolCallId: "tc-2", name: "fd", output: "r2", isError: false, durationMs: 20 },
			]);

			expect(result.toolCalls).toHaveLength(2);
			expect(result.toolCalls[0]!.name).toBe("rg");
			expect(result.toolCalls[1]!.name).toBe("fd");
		});

		test("tool_result without prior tool_use_start creates standalone record", () => {
			const result = buildFromEvents([
				{ type: "tool_result", toolCallId: "tc-orphan", name: "rg", output: "result", isError: false, durationMs: 5 },
			]);

			expect(result.toolCalls).toHaveLength(1);
			expect(result.toolCalls[0]!.id).toBe("tc-orphan");
			expect(result.toolCalls[0]!.name).toBe("rg");
		});
	});

	describe("error handling", () => {
		test("error event sets .error on the result", () => {
			const result = buildFromEvents([
				{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
				{ type: "error", message: "API call failed", details: { code: 500 } },
			]);

			expect(result.error).not.toBeNull();
			expect(result.error!.message).toBe("API call failed");
			expect(result.error!.details).toEqual({ code: 500 });
		});

		test("error with text preserves both", () => {
			const result = buildFromEvents([
				{ type: "text_delta", delta: "partial" },
				{ type: "error", message: "interrupted" },
			]);

			expect(result.text).toBe("partial");
			expect(result.error).not.toBeNull();
			expect(result.error!.message).toBe("interrupted");
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

	describe("compaction", () => {
		test("compaction events are ignored (informational only)", () => {
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
				{ type: "text_delta", delta: "answer" },
				{ type: "text", text: "answer" },
			]);

			expect(result.text).toBe("answer");
			expect(result.error).toBeNull();
		});
	});
});
