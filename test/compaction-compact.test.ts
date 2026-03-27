import { mock, describe, expect, test } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";

const mockSummaryText = "Mock summary of conversation";

mock.module("@mariozechner/pi-ai", () => ({
	completeSimple: async () => ({
		role: "assistant",
		content: [{ type: "text", text: mockSummaryText }],
		stopReason: "end_turn",
		api: "messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	}),
}));

import { compact, maybeCompact, getCompactionSettings } from "../src/compaction";

// =============================================================================
// Helpers
// =============================================================================

const mockModel = {
	id: "test-model",
	name: "Test",
	api: "messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
} as any;

function makeUserMessage(content: string): Message {
	return {
		role: "user",
		content,
		timestamp: Date.now(),
	};
}

function makeAssistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "messages" as never,
		provider: "anthropic" as never,
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeAssistantWithToolCall(toolName: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc-1", name: toolName, arguments: args }],
		api: "messages" as never,
		provider: "anthropic" as never,
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function makeLargeConversation(turnCount: number, charsPerMessage: number): Message[] {
	const messages: Message[] = [];
	for (let i = 0; i < turnCount; i++) {
		messages.push(makeUserMessage(`Q${i}: ${"x".repeat(charsPerMessage)}`));
		messages.push(makeAssistantMessage(`A${i}: ${"y".repeat(charsPerMessage)}`));
	}
	return messages;
}

// =============================================================================
// Tests
// =============================================================================

describe("computeFileLists (indirect via compact)", () => {
	test("3.6.2 file that was only read appears in readFiles, not modifiedFiles", async () => {
		// Create messages where a read tool call is in the summarized portion
		// We need enough messages so findCutPoint produces a non-empty messagesToSummarize
		const messages: Message[] = [
			makeUserMessage("Read the config file"),
			makeAssistantWithToolCall("read", { path: "/src/config.ts" }),
			makeAssistantMessage("Here is the config file content."),
			// Add enough bulk to push these early messages into the summarized portion
			...makeLargeConversation(100, 4000),
		];

		const result = await compact(mockModel, messages);

		expect(result.readFiles).toContain("/src/config.ts");
		expect(result.modifiedFiles).not.toContain("/src/config.ts");
	});
});

describe("compact", () => {
	test("3.7.1 returns summary and kept messages when messages exceed keepRecentTokens", async () => {
		// Generate enough messages so findCutPoint produces a non-empty messagesToSummarize
		// With default keepRecentTokens=20000 and chars/4 heuristic,
		// 200 turns * 4000 chars/msg = 200000 tokens total, well over keepRecentTokens
		const messages = makeLargeConversation(200, 4000);

		const result = await compact(mockModel, messages);

		// Verify structural properties of the compaction result
		expect(result.keptMessages.length).toBeLessThan(messages.length);
		expect(result.keptMessages.length).toBeGreaterThan(0);
		expect(result.firstKeptIndex).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
		// Summary contains the LLM-generated text (from mock)
		expect(result.summary).toContain(mockSummaryText);
		// The summarized messages were actually removed — kept messages start later
		expect(result.keptMessages[0]).toBe(messages[result.firstKeptIndex]);
		// Verify cut landed on a valid turn boundary (user or assistant, never toolResult)
		const firstKept = result.keptMessages[0];
		expect(firstKept).toBeDefined();
		expect(["user", "assistant"]).toContain(firstKept!.role);
	});

	test("3.7.2 returns original messages when nothing to compact", async () => {
		const messages: Message[] = [
			makeUserMessage("Hello"),
			makeAssistantMessage("Hi there!"),
		];

		const result = await compact(mockModel, messages);

		expect(result.keptMessages).toEqual(messages);
		expect(result.firstKeptIndex).toBe(0);
		expect(result.tokensBefore).toBe(result.tokensAfter);
		expect(result.readFiles).toEqual([]);
		expect(result.modifiedFiles).toEqual([]);
	});
});

describe("maybeCompact", () => {
	test("3.8.1 returns wasCompacted: false when under threshold", async () => {
		const messages: Message[] = [
			makeUserMessage("Hello"),
			makeAssistantMessage("Hi!"),
		];

		const result = await maybeCompact(mockModel, messages);

		expect(result.wasCompacted).toBe(false);
		expect(result.messages).toBe(messages); // same reference
	});

	test("3.8.2 returns wasCompacted: true with summary prepended when over threshold", async () => {
		// Need to exceed contextWindow - reserveTokens = 200000 - 16384 = 183616 tokens
		// 200 turns * 4000 chars = 200000 tokens
		const messages = makeLargeConversation(200, 4000);

		const result = await maybeCompact(mockModel, messages);

		expect(result.wasCompacted).toBe(true);
		// Summary message is prepended to the compacted messages
		const firstMsg = result.messages[0];
		expect(firstMsg).toBeDefined();
		expect(typeof firstMsg!.content).toBe("string");
		expect(firstMsg!.content as string).toContain("[CONTEXT SUMMARY");
		expect(firstMsg!.content as string).toContain("[END CONTEXT SUMMARY");
		// Compacted messages are fewer than original
		expect(result.messages.length).toBeLessThan(messages.length);
		// Summary is non-empty
		expect(result.summary!.length).toBeGreaterThan(0);
	});

	test("3.8.3 passes previousSummary through when under threshold", async () => {
		const messages: Message[] = [
			makeUserMessage("Hello"),
			makeAssistantMessage("Hi!"),
		];
		const previousSummary = "Previous session summary content";

		const result = await maybeCompact(mockModel, messages, previousSummary);

		expect(result.summary).toBe(previousSummary);
	});
});
