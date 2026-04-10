import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { processStreamToEvents, type StreamFn } from "../src/stream-processor";
import type { StreamEvent } from "../src/types";

// Mock model and context
const mockModel = {} as Model<Api>;
const mockContext: Context = {
	systemPrompt: "test",
	messages: [],
	tools: [],
};

// Helper to create a mock stream function
function createMockStreamFn(events: { type: string; [key: string]: unknown }[], response: AssistantMessage) {
	return (() => ({
		[Symbol.asyncIterator]: async function* () {
			for (const event of events) {
				yield event;
			}
		},
		result: async () => response,
	})) as unknown as StreamFn;
}

// Helper to create a mock response
function createMockResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 10,
			output: 5,
			totalTokens: 15,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "stop",
	} as AssistantMessage;
}

/** Collect all events from the async generator. */
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

describe("processStreamToEvents", () => {
	describe("text streams", () => {
		test("yields TextDelta events followed by a Text completion", async () => {
			const rawEvents = [
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
			];
			const response = createMockResponse("Hello world");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
				{ type: "text", text: "Hello world" },
			]);
		});

		test("empty stream yields no events", async () => {
			const rawEvents: { type: string }[] = [];
			const response = createMockResponse("Response");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([]);
		});
	});

	describe("thinking streams", () => {
		test("yields ThinkingDelta events followed by a Thinking completion", async () => {
			const rawEvents = [
				{ type: "thinking_delta", delta: "Let me " },
				{ type: "thinking_delta", delta: "think..." },
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([
				{ type: "thinking_delta", delta: "Let me " },
				{ type: "thinking_delta", delta: "think..." },
				{ type: "thinking", text: "Let me think..." },
			]);
		});

		test("thinking followed by text emits Thinking completion before TextDelta", async () => {
			const rawEvents = [
				{ type: "thinking_delta", delta: "reasoning" },
				{ type: "text_delta", delta: "answer" },
			];
			const response = createMockResponse("answer");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([
				{ type: "thinking_delta", delta: "reasoning" },
				{ type: "thinking", text: "reasoning" },
				{ type: "text_delta", delta: "answer" },
				{ type: "text", text: "answer" },
			]);
		});
	});

	describe("tool call streams", () => {
		test("yields ToolUseStart, ToolUseDelta, and ToolUseEnd events", async () => {
			const rawEvents = [
				{
					type: "toolcall_delta",
					delta: '{"pattern":',
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "rg" }] },
				},
				{
					type: "toolcall_delta",
					delta: '"test"}',
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "rg" }] },
				},
				{
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { name: "rg", arguments: { pattern: "test" } },
				},
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([
				{ type: "tool_use_start", toolCallId: "0", name: "rg" },
				{ type: "tool_use_delta", toolCallId: "0", name: "rg", delta: '{"pattern":' },
				{ type: "tool_use_delta", toolCallId: "0", name: "rg", delta: '"test"}' },
				{ type: "tool_use_end", toolCallId: "0", name: "rg", params: { pattern: "test" } },
			]);
		});

		test("multiple tool calls use different toolCallIds", async () => {
			const rawEvents = [
				{
					type: "toolcall_delta",
					delta: "{}",
					contentIndex: 0,
					partial: {
						content: [
							{ type: "toolCall", name: "rg" },
							{ type: "toolCall", name: "fd" },
						],
					},
				},
				{
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { name: "rg", arguments: {} },
				},
				{
					type: "toolcall_delta",
					delta: "{}",
					contentIndex: 1,
					partial: {
						content: [
							{ type: "toolCall", name: "rg" },
							{ type: "toolCall", name: "fd" },
						],
					},
				},
				{
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { name: "fd", arguments: {} },
				},
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			const starts = collected.filter((e) => e.type === "tool_use_start");
			expect(starts).toHaveLength(2);
			expect((starts[0] as { toolCallId: string }).toolCallId).toBe("0");
			expect((starts[1] as { toolCallId: string }).toolCallId).toBe("1");
		});

		test("does not emit duplicate ToolUseStart for same tool call", async () => {
			const rawEvents = [
				{
					type: "toolcall_delta",
					delta: "a",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "rg" }] },
				},
				{
					type: "toolcall_delta",
					delta: "b",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "rg" }] },
				},
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			const starts = collected.filter((e) => e.type === "tool_use_start");
			expect(starts).toHaveLength(1);
		});

		test("text before tool calls emits Text completion first", async () => {
			const rawEvents = [
				{ type: "text_delta", delta: "Let me search" },
				{
					type: "toolcall_delta",
					delta: "{}",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "rg" }] },
				},
			];
			const response = createMockResponse("Let me search");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected[0]).toEqual({ type: "text_delta", delta: "Let me search" });
			expect(collected[1]).toEqual({ type: "text", text: "Let me search" });
			expect(collected[2]?.type).toBe("tool_use_start");
		});
	});

	describe("error handling", () => {
		test("yields TurnError for stream error event", async () => {
			const rawEvents = [
				{ type: "text_delta", delta: "Starting..." },
				{ type: "error", error: { errorMessage: "Rate limit exceeded" } },
			];
			const response = createMockResponse("Never reached");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			const errorEvents = collected.filter((e) => e.type === "error");
			expect(errorEvents).toHaveLength(1);
			expect((errorEvents[0] as { message: string }).message).toBe("API call failed: Rate limit exceeded");
		});

		test("yields TurnError for stream exception", async () => {
			const streamFn = (() => ({
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						throw new Error("Network error");
					},
				}),
				result: async () => createMockResponse("Never reached"),
			})) as unknown as StreamFn;

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			const errorEvents = collected.filter((e) => e.type === "error");
			expect(errorEvents).toHaveLength(1);
			expect((errorEvents[0] as { message: string }).message).toBe("API call failed: Network error");
		});

		test("emits events before error", async () => {
			const rawEvents = [
				{ type: "text_delta", delta: "Hello" },
				{ type: "error", error: { errorMessage: "Error!" } },
			];
			const response = createMockResponse("Never reached");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected[0]).toEqual({ type: "text_delta", delta: "Hello" });
			expect(collected[1]?.type).toBe("error");
		});
	});

	describe("edge cases", () => {
		test("handles toolcall_start event (no-op)", async () => {
			const rawEvents = [{ type: "toolcall_start", contentIndex: 0 }];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([]);
		});

		test("handles unknown event types gracefully", async () => {
			const rawEvents = [{ type: "unknown_event", data: "something" }];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(rawEvents, response);

			const { events } = processStreamToEvents(streamFn, mockModel, mockContext);
			const collected = await collectEvents(events);

			expect(collected).toEqual([]);
		});

		test("response() returns the final AssistantMessage", async () => {
			const rawEvents = [{ type: "text_delta", delta: "Hello" }];
			const expectedResponse = createMockResponse("Hello");
			const streamFn = createMockStreamFn(rawEvents, expectedResponse);

			const result = processStreamToEvents(streamFn, mockModel, mockContext);
			await collectEvents(result.events);
			const response = await result.response();

			expect(response).toBe(expectedResponse);
		});
	});
});
