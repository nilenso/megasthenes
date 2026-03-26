import { describe, expect, test } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import {
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	getCompactionSettings,
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

describe("estimateTokens", () => {
	test("estimates user message tokens", () => {
		const msg = makeUserMessage("Hello, how are you?");
		const tokens = estimateTokens(msg);
		// "Hello, how are you?" = 19 chars, ~5 tokens
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(20);
	});

	test("estimates assistant message tokens", () => {
		const msg = makeAssistantMessage("I'm doing well, thank you for asking!");
		const tokens = estimateTokens(msg);
		expect(tokens).toBeGreaterThan(0);
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
		if (result.messagesToKeep.length > 0) {
			const firstKept = result.messagesToKeep[0];
			if (firstKept) {
				expect(firstKept.role).toBe("user");
			}
		}
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
		if (result.isSplitTurn) {
			expect(result.turnStartIndex).toBe(0); // First user message
			expect(result.turnPrefixMessages.length).toBeGreaterThan(0);
			// First kept message should be an assistant message (mid-turn cut)
			const firstKept = result.messagesToKeep[0];
			if (firstKept) {
				expect(firstKept.role).toBe("assistant");
			}
		}
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
