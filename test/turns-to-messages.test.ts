import { describe, expect, test } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import { reconstructContext } from "../src/turns-to-messages";
import type { Step, TokenUsage, TurnMetadata, TurnResult } from "../src/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ZERO_USAGE: TokenUsage = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

function makeTurnMetadata(overrides?: Partial<TurnMetadata>): TurnMetadata {
	return {
		iterations: 1,
		latencyMs: 100,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		repo: { url: "https://github.com/test/repo", commitish: "abc123" },
		config: { maxIterations: 10 },
		...overrides,
	};
}

function makeTurn(overrides: Partial<TurnResult> & { id: string; prompt: string }): TurnResult {
	return {
		steps: [],
		usage: ZERO_USAGE,
		metadata: makeTurnMetadata(),
		error: null,
		startedAt: 1000,
		endedAt: 2000,
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("reconstructContext", () => {
	test("empty turns → empty messages and snapshots", () => {
		const { messages, turnSnapshots } = reconstructContext([]);
		expect(messages).toEqual([]);
		expect(turnSnapshots.size).toBe(0);
	});

	test("single text-only turn → UserMessage + AssistantMessage", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "What does this do?",
			steps: [{ type: "text", text: "It does X.", role: "assistant" }],
		});

		const { messages, turnSnapshots } = reconstructContext([turn]);

		expect(messages).toHaveLength(2);

		// UserMessage
		expect(messages[0]?.role).toBe("user");
		expect((messages[0] as { content: string }).content).toBe("What does this do?");
		expect(messages[0]?.timestamp).toBe(1000);

		// AssistantMessage
		expect(messages[1]?.role).toBe("assistant");
		const assistant = messages[1] as Extract<Message, { role: "assistant" }>;
		expect(assistant.content).toEqual([{ type: "text", text: "It does X." }]);
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.provider).toBe("anthropic");
		expect(assistant.model).toBe("claude-sonnet-4-6");

		// Snapshot
		expect(turnSnapshots.get("t1")).toHaveLength(2);
	});

	test("turn with tool calls → AssistantMessage(toolCalls) + ToolResultMessages", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Search for bugs",
			steps: [
				{ type: "text", text: "I'll search.", role: "assistant" },
				{
					type: "tool_call",
					id: "tc1",
					name: "rg",
					params: { pattern: "bug" },
					output: "found a bug",
					isError: false,
					durationMs: 50,
				},
				{ type: "text", text: "Found one.", role: "assistant" },
			],
			metadata: makeTurnMetadata({ iterations: 2 }),
		});

		const { messages } = reconstructContext([turn]);

		// UserMessage + AssistantMessage(text+toolCall) + ToolResult + AssistantMessage(text)
		expect(messages).toHaveLength(4);

		expect(messages[0]?.role).toBe("user");

		// First AssistantMessage: text + toolCall
		const a1 = messages[1] as Extract<Message, { role: "assistant" }>;
		expect(a1.role).toBe("assistant");
		expect(a1.content).toHaveLength(2);
		expect(a1.content[0]).toEqual({ type: "text", text: "I'll search." });
		expect(a1.content[1]).toMatchObject({ type: "toolCall", id: "tc1", name: "rg", arguments: { pattern: "bug" } });
		expect(a1.stopReason).toBe("toolUse");

		// ToolResult
		const tr = messages[2] as Extract<Message, { role: "toolResult" }>;
		expect(tr.role).toBe("toolResult");
		expect(tr.toolCallId).toBe("tc1");
		expect(tr.toolName).toBe("rg");
		expect(tr.content).toEqual([{ type: "text", text: "found a bug" }]);
		expect(tr.isError).toBe(false);

		// Second AssistantMessage: final text
		const a2 = messages[3] as Extract<Message, { role: "assistant" }>;
		expect(a2.content).toEqual([{ type: "text", text: "Found one." }]);
		expect(a2.stopReason).toBe("stop");
	});

	test("multi-iteration turn with tool chain", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Find and read the config",
			steps: [
				{ type: "text", text: "I'll find the config.", role: "assistant" },
				{
					type: "tool_call",
					id: "tc1",
					name: "rg",
					params: { pattern: "config" },
					output: "config.ts",
					isError: false,
					durationMs: 30,
				},
				{ type: "text", text: "Let me read it.", role: "assistant" },
				{
					type: "tool_call",
					id: "tc2",
					name: "read",
					params: { path: "config.ts" },
					output: "export default {}",
					isError: false,
					durationMs: 20,
				},
				{ type: "text", text: "Here's the config.", role: "assistant" },
			],
			metadata: makeTurnMetadata({ iterations: 3 }),
		});

		const { messages } = reconstructContext([turn]);

		// user + assistant(text+tc1) + toolResult(tc1) + assistant(text+tc2) + toolResult(tc2) + assistant(text)
		expect(messages).toHaveLength(6);

		expect(messages[0]?.role).toBe("user");
		expect(messages[1]?.role).toBe("assistant");
		expect(messages[2]?.role).toBe("toolResult");
		expect(messages[3]?.role).toBe("assistant");
		expect(messages[4]?.role).toBe("toolResult");

		const a3 = messages[5] as Extract<Message, { role: "assistant" }>;
		expect(a3.content).toEqual([{ type: "text", text: "Here's the config." }]);
		expect(a3.stopReason).toBe("stop");
	});

	test("multi-turn conversation → correct ordering and snapshots", () => {
		const turn1 = makeTurn({
			id: "t1",
			prompt: "Hello",
			steps: [{ type: "text", text: "Hi there!", role: "assistant" }],
			startedAt: 1000,
		});
		const turn2 = makeTurn({
			id: "t2",
			prompt: "What is this?",
			steps: [{ type: "text", text: "This is a repo.", role: "assistant" }],
			startedAt: 2000,
		});

		const { messages, turnSnapshots } = reconstructContext([turn1, turn2]);

		expect(messages).toHaveLength(4);
		expect(messages[0]?.role).toBe("user");
		expect((messages[0] as { content: string }).content).toBe("Hello");
		expect(messages[1]?.role).toBe("assistant");
		expect(messages[2]?.role).toBe("user");
		expect((messages[2] as { content: string }).content).toBe("What is this?");
		expect(messages[3]?.role).toBe("assistant");

		// Snapshot after turn 1: just the first 2 messages
		expect(turnSnapshots.get("t1")).toHaveLength(2);
		// Snapshot after turn 2: all 4 messages
		expect(turnSnapshots.get("t2")).toHaveLength(4);
	});

	test("thinking steps are excluded from reconstructed messages", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Think about this",
			steps: [
				{ type: "thinking", text: "Let me reason..." },
				{ type: "text", text: "Here's my answer.", role: "assistant" },
			],
		});

		const { messages } = reconstructContext([turn]);

		expect(messages).toHaveLength(2); // user + assistant only
		const assistant = messages[1] as Extract<Message, { role: "assistant" }>;
		// Only text content, no thinking
		expect(assistant.content).toEqual([{ type: "text", text: "Here's my answer." }]);
	});

	test("thinking_summary steps are excluded", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Test",
			steps: [
				{ type: "thinking_summary", text: "Summary of reasoning" },
				{ type: "text", text: "Answer.", role: "assistant" },
			],
		});

		const { messages } = reconstructContext([turn]);
		expect(messages).toHaveLength(2);
	});

	test("error and compaction steps are excluded", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Test",
			steps: [
				{ type: "compaction", summary: "Previous context...", tokensBefore: 5000, tokensAfter: 1000 },
				{ type: "text", text: "Answer.", role: "assistant" },
				{
					type: "error",
					errorType: "provider_error",
					source: "provider",
					message: "Rate limited",
					isRetryable: null,
				},
			],
		});

		const { messages } = reconstructContext([turn]);
		expect(messages).toHaveLength(2); // user + assistant
	});

	test("failed tool call preserves isError: true", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Read a file",
			steps: [
				{
					type: "tool_call",
					id: "tc1",
					name: "read",
					params: { path: "/nope" },
					output: "File not found",
					isError: true,
					durationMs: 10,
				},
				{ type: "text", text: "Sorry, file not found.", role: "assistant" },
			],
		});

		const { messages } = reconstructContext([turn]);

		// user + assistant(toolCall) + toolResult + assistant(text)
		expect(messages).toHaveLength(4);

		const tr = messages[2] as Extract<Message, { role: "toolResult" }>;
		expect(tr.isError).toBe(true);
		expect(tr.content).toEqual([{ type: "text", text: "File not found" }]);
	});

	test("turn with only tool calls (no text) → AssistantMessage with toolCall blocks only", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Do something",
			steps: [
				{
					type: "tool_call",
					id: "tc1",
					name: "rg",
					params: { pattern: "x" },
					output: "result",
					isError: false,
					durationMs: 10,
				},
			],
		});

		const { messages } = reconstructContext([turn]);

		// user + assistant(toolCall) + toolResult
		expect(messages).toHaveLength(3);

		const assistant = messages[1] as Extract<Message, { role: "assistant" }>;
		expect(assistant.content).toHaveLength(1);
		expect(assistant.content[0]?.type).toBe("toolCall");
		expect(assistant.stopReason).toBe("toolUse");
	});

	test("multiple tool calls in the same iteration", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Search for both",
			steps: [
				{ type: "text", text: "I'll search.", role: "assistant" },
				{
					type: "tool_call",
					id: "tc1",
					name: "rg",
					params: { pattern: "a" },
					output: "found a",
					isError: false,
					durationMs: 10,
				},
				{
					type: "tool_call",
					id: "tc2",
					name: "rg",
					params: { pattern: "b" },
					output: "found b",
					isError: false,
					durationMs: 10,
				},
				{ type: "text", text: "Found both.", role: "assistant" },
			],
		});

		const { messages } = reconstructContext([turn]);

		// user + assistant(text+tc1+tc2) + toolResult(tc1) + toolResult(tc2) + assistant(text)
		expect(messages).toHaveLength(5);

		const a1 = messages[1] as Extract<Message, { role: "assistant" }>;
		expect(a1.content).toHaveLength(3); // text + 2 toolCalls
		expect(a1.stopReason).toBe("toolUse");

		expect(messages[2]?.role).toBe("toolResult");
		expect(messages[3]?.role).toBe("toolResult");

		const a2 = messages[4] as Extract<Message, { role: "assistant" }>;
		expect(a2.content).toEqual([{ type: "text", text: "Found both." }]);
		expect(a2.stopReason).toBe("stop");
	});

	test("turn with no steps → only UserMessage", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Empty turn",
			steps: [],
		});

		const { messages } = reconstructContext([turn]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
	});

	test("iteration_start steps are ignored gracefully", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Test",
			steps: [{ type: "iteration_start", index: 0 } as Step, { type: "text", text: "Answer.", role: "assistant" }],
		});

		const { messages } = reconstructContext([turn]);
		expect(messages).toHaveLength(2);
	});

	test("snapshots are independent copies", () => {
		const turn1 = makeTurn({
			id: "t1",
			prompt: "First",
			steps: [{ type: "text", text: "Response 1", role: "assistant" }],
		});
		const turn2 = makeTurn({
			id: "t2",
			prompt: "Second",
			steps: [{ type: "text", text: "Response 2", role: "assistant" }],
		});

		const { messages, turnSnapshots } = reconstructContext([turn1, turn2]);

		const snap1 = turnSnapshots.get("t1")!;
		const snap2 = turnSnapshots.get("t2")!;

		// Mutating snap1 should not affect snap2 or messages
		snap1.push({ role: "user", content: "injected", timestamp: 0 });
		expect(snap2).toHaveLength(4);
		expect(messages).toHaveLength(4);
	});

	test("uses model metadata from turn for reconstructed AssistantMessages", () => {
		const turn = makeTurn({
			id: "t1",
			prompt: "Test",
			steps: [{ type: "text", text: "Hi", role: "assistant" }],
			metadata: makeTurnMetadata({ model: { provider: "google", id: "gemini-2.5-pro" } }),
		});

		const { messages } = reconstructContext([turn]);
		const assistant = messages[1] as Extract<Message, { role: "assistant" }>;
		expect(assistant.provider).toBe("google");
		expect(assistant.model).toBe("gemini-2.5-pro");
	});
});
