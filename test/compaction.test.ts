import { describe, expect, mock, test } from "bun:test";
import type { Api, Message, Model } from "@mariozechner/pi-ai";

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

import {
	compact,
	compactionTestInternals,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	getCompactionSettings,
	maybeCompact,
	serializeConversation,
	shouldCompact,
} from "../src/compaction";

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
} as unknown as Model<Api>;

describe("estimateTokens", () => {
	test("estimates user message tokens", () => {
		const msg = makeUserMessage("Hello, how are you?");
		const tokens = estimateTokens(msg);
		// "Hello, how are you?" = 19 chars -> Math.ceil(19/4) = 5
		expect(tokens).toBe(5);
	});

	test("estimates assistant message tokens", () => {
		const msg = makeAssistantMessage("I'm doing well, thank you for asking!");
		const tokens = estimateTokens(msg);
		// 37 chars -> Math.ceil(37/4) = 10
		expect(tokens).toBe(10);
	});
});

describe("estimateContextTokens", () => {
	test("sums tokens for multiple messages", () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi there!")];

		const total = estimateContextTokens(messages);
		const msg0 = messages[0];
		const msg1 = messages[1];
		if (!msg0 || !msg1) throw new Error("Messages not found");
		expect(total).toBe(estimateTokens(msg0) + estimateTokens(msg1));
	});

	test("matches the token index total", () => {
		const messages: Message[] = [
			makeUserMessage("Hello"),
			makeAssistantMessage("Hi there!"),
			makeAssistantWithToolCall("read", { path: "/src/config.ts" }),
		];

		const tokenIndex = compactionTestInternals.buildTokenEstimateIndex(messages);

		expect(tokenIndex.total).toBe(estimateContextTokens(messages));
	});
});

describe("shouldCompact", () => {
	test("returns false when under threshold", () => {
		const settings = getCompactionSettings();
		const tokens = 10000; // Well under the threshold
		expect(shouldCompact(tokens, settings)).toBe(false);
	});

	test("returns true when over threshold", () => {
		const settings = getCompactionSettings();
		const tokens = settings.contextWindow - settings.reserveTokens + 1000;
		expect(shouldCompact(tokens, settings)).toBe(true);
	});

	test("returns false when disabled", () => {
		const settings = { ...getCompactionSettings(), enabled: false };
		const tokens = 999999;
		expect(shouldCompact(tokens, settings)).toBe(false);
	});

	test("returns true at exact boundary (contextWindow - reserveTokens + 1)", () => {
		const settings = getCompactionSettings();
		const boundary = settings.contextWindow - settings.reserveTokens;
		expect(shouldCompact(boundary, settings)).toBe(false);
		expect(shouldCompact(boundary + 1, settings)).toBe(true);
	});
});

describe("serializeConversation", () => {
	test("serializes user and assistant messages", () => {
		const messages: Message[] = [makeUserMessage("What is 2+2?"), makeAssistantMessage("The answer is 4.")];

		const serialized = serializeConversation(messages);
		expect(serialized).toContain("[User]: What is 2+2?");
		expect(serialized).toContain("[Assistant]: The answer is 4.");
	});

	test("serializes tool calls", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "123",
						name: "read",
						arguments: { path: "foo.ts" },
					},
				],
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
			},
		];

		const serialized = serializeConversation(messages);
		expect(serialized).toContain("[Assistant tool calls]:");
		expect(serialized).toContain('read(path="foo.ts")');
	});
});

describe("findCutPoint", () => {
	test("matches indexed cut point selection", () => {
		const messages: Message[] = [
			makeUserMessage("First question"),
			makeAssistantMessage("First answer"),
			makeUserMessage(`Second question with ${"x".repeat(1000)}`),
			makeAssistantMessage(`Second answer part 1 ${"y".repeat(500)}`),
			makeAssistantMessage(`Second answer part 2 ${"z".repeat(500)}`),
		];
		const settings = { ...getCompactionSettings(), keepRecentTokens: 300 };
		const tokenIndex = compactionTestInternals.buildTokenEstimateIndex(messages);

		const directResult = findCutPoint(messages, settings);
		const indexedResult = compactionTestInternals.findCutPointFromIndex(messages, settings, tokenIndex);

		expect(indexedResult).toEqual(directResult);
	});

	test("returns all messages if under budget", () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi!")];

		const settings = { ...getCompactionSettings(), keepRecentTokens: 100000 };
		const result = findCutPoint(messages, settings);

		expect(result.messagesToSummarize).toHaveLength(0);
		expect(result.messagesToKeep).toHaveLength(2);
	});

	test("cuts at user message boundaries", () => {
		// Create many messages to exceed budget
		const messages: Message[] = [];
		for (let i = 0; i < 20; i++) {
			messages.push(makeUserMessage(`Question ${i}: ${"x".repeat(500)}`));
			messages.push(makeAssistantMessage(`Answer ${i}: ${"y".repeat(500)}`));
		}

		const settings = { ...getCompactionSettings(), keepRecentTokens: 1000 };
		const result = findCutPoint(messages, settings);

		// Should have some messages to summarize
		expect(result.messagesToSummarize.length).toBeGreaterThan(0);

		// First kept message should be a user message (turn boundary)
		expect(result.messagesToKeep.length).toBeGreaterThan(0);
		expect(result.messagesToKeep[0]?.role).toBe("user");
	});

	test("handles split turn when single turn exceeds budget", () => {
		// Single turn with many assistant messages (simulating tool calls)
		const messages: Message[] = [
			makeUserMessage("Refactor all the files"),
			makeAssistantMessage("Starting refactor...".repeat(50)),
			makeAssistantMessage("Continuing refactor...".repeat(50)),
			makeAssistantMessage("More refactor...".repeat(50)),
			makeAssistantMessage("Almost done...".repeat(50)),
			makeAssistantMessage("Final changes...".repeat(50)),
		];

		const settings = { ...getCompactionSettings(), keepRecentTokens: 500 };
		const result = findCutPoint(messages, settings);

		// Should detect split turn
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(0); // First user message
		expect(result.turnPrefixMessages.length).toBeGreaterThan(0);
		// First kept message should be an assistant message (mid-turn cut)
		expect(result.messagesToKeep.length).toBeGreaterThan(0);
		expect(result.messagesToKeep[0]?.role).toBe("assistant");
	});

	test("can cut at assistant message boundaries", () => {
		// Multiple turns, but a very long assistant response
		const messages: Message[] = [
			makeUserMessage("First question"),
			makeAssistantMessage("First answer"),
			makeUserMessage(`Second question with ${"x".repeat(1000)}`),
			makeAssistantMessage(`Second answer part 1 ${"y".repeat(500)}`),
			makeAssistantMessage(`Second answer part 2 ${"z".repeat(500)}`),
		];

		const settings = { ...getCompactionSettings(), keepRecentTokens: 300 };
		const result = findCutPoint(messages, settings);

		// Should be able to cut somewhere
		expect(result.firstKeptIndex).toBeGreaterThan(0);
	});
});

describe("computeFileLists (indirect via compact)", () => {
	test("file read in summarized portion is tracked as read-only", async () => {
		const messages: Message[] = [
			makeUserMessage("Read the config file"),
			makeAssistantWithToolCall("read", { path: "/src/config.ts" }),
			makeAssistantMessage("Here is the config file content."),
			...makeLargeConversation(100, 4000),
		];

		const result = await compact(mockModel, messages);

		expect(result.readFiles).toContain("/src/config.ts");
		expect(result.modifiedFiles).not.toContain("/src/config.ts");
	});
});

describe("compact", () => {
	test("returns summary and kept messages when messages exceed keepRecentTokens", async () => {
		const messages = makeLargeConversation(200, 4000);

		const result = await compact(mockModel, messages);

		expect(result.keptMessages.length).toBeLessThan(messages.length);
		expect(result.keptMessages.length).toBeGreaterThan(0);
		expect(result.firstKeptIndex).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
		expect(result.summary).toContain(mockSummaryText);
		expect(result.keptMessages[0]).toBe(messages[result.firstKeptIndex]);
		const firstKept = result.keptMessages[0];
		expect(firstKept).toBeDefined();
		if (!firstKept) throw new Error("Missing kept message");
		expect(["user", "assistant"]).toContain(firstKept.role);
	});

	test("returns original messages when nothing to compact", async () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi there!")];

		const result = await compact(mockModel, messages);

		expect(result.keptMessages).toEqual(messages);
		expect(result.firstKeptIndex).toBe(0);
		expect(result.tokensBefore).toBe(result.tokensAfter);
		expect(result.readFiles).toEqual([]);
		expect(result.modifiedFiles).toEqual([]);
	});
});

describe("maybeCompact", () => {
	test("returns wasCompacted=false when under threshold", async () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi!")];

		const result = await maybeCompact(mockModel, messages);

		expect(result.wasCompacted).toBe(false);
		expect(result.messages).toBe(messages);
	});

	test("metadata remains consistent on non-compacting path", async () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi!")];
		const expectedTokens = estimateContextTokens(messages);

		const result = await maybeCompact(mockModel, messages);

		expect(result.wasCompacted).toBe(false);
		expect(result.firstKeptOrdinal).toBe(0);
		expect(result.tokensBefore).toBe(expectedTokens);
		expect(result.tokensAfter).toBe(expectedTokens);
		expect(result.readFiles).toEqual([]);
		expect(result.modifiedFiles).toEqual([]);
	});

	test("returns wasCompacted=true with summary prepended when over threshold", async () => {
		const messages = makeLargeConversation(200, 4000);

		const result = await maybeCompact(mockModel, messages);

		expect(result.wasCompacted).toBe(true);
		const firstMsg = result.messages[0];
		expect(firstMsg).toBeDefined();
		expect(typeof firstMsg?.content).toBe("string");
		expect(firstMsg?.content as string).toContain("[CONTEXT SUMMARY");
		expect(firstMsg?.content as string).toContain("[END CONTEXT SUMMARY");
		expect(result.messages.length).toBeLessThan(messages.length);
		expect((result.summary ?? "").length).toBeGreaterThan(0);
	});

	test("preserves suffix and metadata on compacting path", async () => {
		const messages = makeLargeConversation(200, 4000);
		const expectedTokens = estimateContextTokens(messages);

		const result = await maybeCompact(mockModel, messages);

		expect(result.wasCompacted).toBe(true);
		expect(result.firstKeptOrdinal).toBeGreaterThan(0);
		expect(result.tokensBefore).toBe(expectedTokens);
		expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
		const firstMsg = result.messages[0];
		expect(firstMsg).toBeDefined();
		expect(firstMsg?.role).toBe("user");
		expect(typeof firstMsg?.content).toBe("string");
		expect(result.messages.slice(1)).toEqual(messages.slice(result.firstKeptOrdinal));
	});

	test("passes previousSummary through when under threshold", async () => {
		const messages: Message[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi!")];
		const previousSummary = "Previous session summary content";

		const result = await maybeCompact(mockModel, messages, previousSummary);

		expect(result.summary).toBe(previousSummary);
	});
});
