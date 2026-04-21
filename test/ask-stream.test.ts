import { describe, expect, test } from "bun:test";
import { AskStreamImpl } from "../src/ask-stream";
import type { StreamEvent } from "../src/types";

function makeProducer(events: StreamEvent[]) {
	return async function* () {
		for (const event of events) {
			yield event;
		}
	};
}

describe("AskStream", () => {
	test("iterating yields all events in order", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Hello", timestamp: 1000 },
			{ type: "text_delta", delta: "Hi" },
			{ type: "text", text: "Hi" },
			{
				type: "turn_end",
				turnId: "t-1",
				metadata: {
					iterations: 1,
					latencyMs: 50,
					model: { provider: "test", id: "m" },
					repo: { url: "", commitish: "" },
					config: { maxIterations: 5 },
				},
			},
		];
		const stream = new AskStreamImpl(makeProducer(events));

		const collected: StreamEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}

		expect(collected).toEqual(events);
	});

	test(".result() without iterating drains and returns TurnResult", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Hello", timestamp: 1000 },
			{ type: "text_delta", delta: "Hi" },
			{ type: "text", text: "Hi" },
			{
				type: "turn_end",
				turnId: "t-1",
				metadata: {
					iterations: 1,
					latencyMs: 50,
					model: { provider: "test", id: "m" },
					repo: { url: "", commitish: "" },
					config: { maxIterations: 5 },
				},
			},
		];
		const stream = new AskStreamImpl(makeProducer(events));

		const result = await stream.result();

		expect(result.id).toBe("t-1");
		expect(result.prompt).toBe("Hello");
		expect(result.steps).toHaveLength(1); // text step
		expect(result.steps[0]).toEqual({ type: "text", text: "Hi", role: "assistant" });
	});

	test("iterate then .result() returns the same TurnResult", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
			{ type: "text", text: "A" },
			{
				type: "turn_end",
				turnId: "t-1",
				metadata: {
					iterations: 1,
					latencyMs: 50,
					model: { provider: "test", id: "m" },
					repo: { url: "", commitish: "" },
					config: { maxIterations: 5 },
				},
			},
		];
		const stream = new AskStreamImpl(makeProducer(events));

		const collected: StreamEvent[] = [];
		for await (const event of stream) {
			collected.push(event);
		}
		expect(collected).toHaveLength(3);

		const result = await stream.result();
		expect(result.id).toBe("t-1");
		expect(result.steps[0]).toEqual({ type: "text", text: "A", role: "assistant" });
	});

	test(".result() called twice returns the same cached object", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
			{ type: "text", text: "A" },
		];
		const stream = new AskStreamImpl(makeProducer(events));

		const r1 = await stream.result();
		const r2 = await stream.result();

		expect(r1).toBe(r2); // same reference
	});

	test("error stream produces TurnResult with .error set", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
			{
				type: "error",
				errorType: "provider_error",
				message: "API failed",
				retryability: "unknown",
				details: { code: 500 },
			},
		];
		const stream = new AskStreamImpl(makeProducer(events));

		const result = await stream.result();

		expect(result.error).not.toBeNull();
		expect(result.error?.message).toBe("API failed");
	});

	test("stream with tool calls produces correct steps", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Search", timestamp: 1000 },
			{ type: "tool_use_start", toolCallId: "tc-1", name: "rg" },
			{ type: "tool_use_end", toolCallId: "tc-1", name: "rg", params: { pattern: "test" } },
			{ type: "tool_result", toolCallId: "tc-1", name: "rg", output: "found", isError: false, durationMs: 10 },
			{ type: "text", text: "Here's what I found" },
		];
		const stream = new AskStreamImpl(makeProducer(events));

		const result = await stream.result();

		expect(result.steps).toHaveLength(2);
		expect(result.steps[0]?.type).toBe("tool_call");
		expect(result.steps[1]?.type).toBe("text");
	});

	test("concurrent iteration + .result() — result waits for iterator", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
			{ type: "text", text: "A" },
			{
				type: "turn_end",
				turnId: "t-1",
				metadata: {
					iterations: 1,
					latencyMs: 50,
					model: { provider: "test", id: "m" },
					repo: { url: "", commitish: "" },
					config: { maxIterations: 5 },
				},
			},
		];

		// No explicit sync: async generator bodies execute synchronously up to the
		// first yield, so by the time the iterator IIFE is created, the iterator
		// has already set #consuming=true. .result() is guaranteed to observe
		// mid-iteration and take the wait-for-done path.
		const stream = new AskStreamImpl(async function* () {
			yield* events;
		});

		const collected: StreamEvent[] = [];
		const iterPromise = (async () => {
			for await (const event of stream) {
				collected.push(event);
			}
		})();
		const resultPromise = stream.result();

		const [, result] = await Promise.all([iterPromise, resultPromise]);

		expect(collected).toEqual(events);
		expect(result.id).toBe("t-1");
		expect(result.steps[0]).toEqual({ type: "text", text: "A", role: "assistant" });
	});

	test("early break from iterator — .result() still resolves", async () => {
		const events: StreamEvent[] = [
			{ type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 },
			{ type: "text_delta", delta: "A" },
			{ type: "text", text: "A" },
			{
				type: "turn_end",
				turnId: "t-1",
				metadata: {
					iterations: 1,
					latencyMs: 50,
					model: { provider: "test", id: "m" },
					repo: { url: "", commitish: "" },
					config: { maxIterations: 5 },
				},
			},
		];
		const stream = new AskStreamImpl(makeProducer(events));

		// Consume only the first event, then break
		for await (const _event of stream) {
			break;
		}

		// .result() must not hang — should resolve with partial result
		const result = await stream.result();
		expect(result).toBeDefined();
	});

	test("lazy start — producer not called until consumed", async () => {
		let started = false;
		const producer = async function* () {
			started = true;
			yield { type: "text", text: "A" } as StreamEvent;
		};
		const _stream = new AskStreamImpl(producer);

		expect(started).toBe(false);
	});

	describe("producer throws", () => {
		test("producer throws before any yield — .result() rejects with the producer's error", async () => {
			const sentinel = new Error("sentinel: producer pre-yield");
			const producer = async function* (): AsyncGenerator<StreamEvent> {
				// Touch `yield` after the throw so TypeScript still treats this as
				// a generator, but Biome doesn't flag an unreachable statement.
				if ((0 as number) === 1) yield { type: "text", text: "unreachable" };
				throw sentinel;
			};
			const stream = new AskStreamImpl(producer);

			// Identity check (not message-text check): the same error object
			// round-trips out through .result().
			await expect(stream.result()).rejects.toBe(sentinel);
		});

		test("producer throws mid-stream while iterating — iterator rethrows and iteration terminates", async () => {
			const sentinel = new Error("sentinel: mid-stream");
			const producer = async function* (): AsyncGenerator<StreamEvent> {
				yield { type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 };
				yield { type: "text_delta", delta: "partial" };
				throw sentinel;
			};
			const stream = new AskStreamImpl(producer);

			const collected: StreamEvent[] = [];
			let caught: unknown;
			try {
				for await (const event of stream) {
					collected.push(event);
				}
			} catch (error) {
				caught = error;
			}

			expect(caught).toBe(sentinel);
			// Events observed before the throw are still delivered in order.
			expect(collected.map((e) => e.type)).toEqual(["turn_start", "text_delta"]);
		});

		test("after iteration throws, .result() resolves with the partial TurnResult built so far", async () => {
			const sentinel = new Error("sentinel: mid-stream");
			const producer = async function* (): AsyncGenerator<StreamEvent> {
				yield { type: "turn_start", turnId: "t-1", prompt: "Q", timestamp: 1000 };
				yield { type: "text", text: "partial answer" };
				throw sentinel;
			};
			const stream = new AskStreamImpl(producer);

			// Consume until the producer throws; the iterator's finally clause
			// marks the stream done and snapshots the builder state.
			try {
				for await (const _event of stream) {
					// no-op
				}
			} catch {
				// expected
			}

			const result = await stream.result();
			expect(result.id).toBe("t-1");
			expect(result.prompt).toBe("Q");
			expect(result.steps).toEqual([{ type: "text", text: "partial answer", role: "assistant" }]);
		});
	});
});
