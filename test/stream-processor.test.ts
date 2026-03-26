import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import type { ProgressEvent } from "../src/session";
import { processStream, type StreamFn } from "../src/stream-processor";

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

// Helper to create a mock stream function that captures the options it receives
function createCapturingStreamFn(events: { type: string; [key: string]: unknown }[], response: AssistantMessage) {
	let capturedOptions: unknown;
	const streamFn = ((_model: unknown, _context: unknown, options?: unknown) => {
		capturedOptions = options;
		return {
			[Symbol.asyncIterator]: async function* () {
				for (const event of events) {
					yield event;
				}
			},
			result: async () => response,
		};
	}) as unknown as StreamFn;
	return { streamFn, getCapturedOptions: () => capturedOptions };
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

describe("processStream", () => {
	describe("successful streams", () => {
		test("returns success with response for simple text stream", async () => {
			const events = [{ type: "text_delta", delta: "Hello" }];
			const response = createMockResponse("Hello world");
			const streamFn = createMockStreamFn(events, response);

			const outcome = await processStream(streamFn, mockModel, mockContext);

			expect(outcome.ok).toBe(true);
			if (outcome.ok) {
				expect(outcome.response).toBe(response);
			}
		});

		test("returns success for empty event stream", async () => {
			const events: { type: string }[] = [];
			const response = createMockResponse("Response");
			const streamFn = createMockStreamFn(events, response);

			const outcome = await processStream(streamFn, mockModel, mockContext);

			expect(outcome.ok).toBe(true);
		});
	});

	describe("progress events", () => {
		test("emits text_delta events", async () => {
			const events = [
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
			];
			const response = createMockResponse("Hello world");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(progressEvents).toEqual([
				{ type: "text_delta", delta: "Hello" },
				{ type: "text_delta", delta: " world" },
			]);
		});

		test("emits thinking_delta events", async () => {
			const events = [{ type: "thinking_delta", delta: "Let me think..." }];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(progressEvents).toEqual([{ type: "thinking_delta", delta: "Let me think..." }]);
		});

		test("emits tool_end events", async () => {
			const events = [
				{
					type: "toolcall_end",
					toolCall: { name: "read_file", arguments: { path: "test.txt" } },
					contentIndex: 0,
				},
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(progressEvents).toEqual([{ type: "tool_end", name: "read_file", arguments: { path: "test.txt" } }]);
		});

		test("emits tool_start before tool_delta for new tool calls", async () => {
			const events = [
				{
					type: "toolcall_delta",
					delta: '{"path":',
					contentIndex: 0,
					partial: {
						content: [{ type: "toolCall", name: "read_file" }],
					},
				},
				{
					type: "toolcall_delta",
					delta: '"test.txt"}',
					contentIndex: 0,
					partial: {
						content: [{ type: "toolCall", name: "read_file" }],
					},
				},
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(progressEvents).toEqual([
				{ type: "tool_start", name: "read_file", arguments: {} },
				{ type: "tool_delta", name: "read_file", delta: '{"path":' },
				{ type: "tool_delta", name: "read_file", delta: '"test.txt"}' },
			]);
		});

		test("does not emit duplicate tool_start for same tool call", async () => {
			const events = [
				{
					type: "toolcall_delta",
					delta: "a",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "tool1" }] },
				},
				{
					type: "toolcall_delta",
					delta: "b",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "tool1" }] },
				},
				{
					type: "toolcall_delta",
					delta: "c",
					contentIndex: 0,
					partial: { content: [{ type: "toolCall", name: "tool1" }] },
				},
			];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			const toolStartEvents = progressEvents.filter((e) => e.type === "tool_start");
			expect(toolStartEvents.length).toBe(1);
		});
	});

	describe("error handling", () => {
		test("returns error for stream error event", async () => {
			const events = [
				{ type: "text_delta", delta: "Starting..." },
				{ type: "error", error: { errorMessage: "Rate limit exceeded" } },
			];
			const response = createMockResponse("Never reached");
			const streamFn = createMockStreamFn(events, response);

			const outcome = await processStream(streamFn, mockModel, mockContext);

			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error).toBe("API call failed: Rate limit exceeded");
				expect(outcome.errorDetails).toEqual({ errorMessage: "Rate limit exceeded" });
			}
		});

		test("returns error for stream exception", async () => {
			const streamFn = (() => ({
				[Symbol.asyncIterator]: () => ({
					next: async () => {
						throw new Error("Network error");
					},
				}),
				result: async () => createMockResponse("Never reached"),
			})) as unknown as StreamFn;

			const outcome = await processStream(streamFn, mockModel, mockContext);

			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.error).toBe("API call failed: Network error");
			}
		});

		test("emits progress events before error", async () => {
			const events = [
				{ type: "text_delta", delta: "Hello" },
				{ type: "error", error: { errorMessage: "Error!" } },
			];
			const response = createMockResponse("Never reached");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			const outcome = await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(outcome.ok).toBe(false);
			expect(progressEvents).toEqual([{ type: "text_delta", delta: "Hello" }]);
		});
	});

	describe("edge cases", () => {
		test("handles toolcall_start event (no-op)", async () => {
			const events = [{ type: "toolcall_start", contentIndex: 0 }];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			const outcome = await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(outcome.ok).toBe(true);
			expect(progressEvents).toEqual([]);
		});

		test("handles unknown event types gracefully", async () => {
			const events = [{ type: "unknown_event", data: "something" }];
			const response = createMockResponse("Result");
			const streamFn = createMockStreamFn(events, response);

			const progressEvents: ProgressEvent[] = [];
			const outcome = await processStream(streamFn, mockModel, mockContext, (event) => progressEvents.push(event));

			expect(outcome.ok).toBe(true);
			expect(progressEvents).toEqual([]);
		});

		test("works without onProgress callback", async () => {
			const events = [{ type: "text_delta", delta: "Hello" }];
			const response = createMockResponse("Hello");
			const streamFn = createMockStreamFn(events, response);

			const outcome = await processStream(streamFn, mockModel, mockContext);

			expect(outcome.ok).toBe(true);
		});
	});

	describe("stream options", () => {
		test("forwards streamOptions to streamFn", async () => {
			const events = [{ type: "text_delta", delta: "Hello" }];
			const response = createMockResponse("Hello");
			const { streamFn, getCapturedOptions } = createCapturingStreamFn(events, response);

			const streamOptions = { thinkingEnabled: true };
			const outcome = await processStream(streamFn, mockModel, mockContext, undefined, streamOptions);

			expect(outcome.ok).toBe(true);
			expect(getCapturedOptions()).toEqual(streamOptions);
		});

		test("passes undefined when no streamOptions provided", async () => {
			const events = [{ type: "text_delta", delta: "Hello" }];
			const response = createMockResponse("Hello");
			const { streamFn, getCapturedOptions } = createCapturingStreamFn(events, response);

			await processStream(streamFn, mockModel, mockContext);

			expect(getCapturedOptions()).toBeUndefined();
		});
	});
});
