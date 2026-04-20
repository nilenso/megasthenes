import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { Repo } from "../src/forge";
import { nullLogger } from "../src/logger";
import { classifyResponse, Session, type SessionConfig } from "../src/session";
import { createCapturingLogger } from "./helpers/capturing-logger";

// Mock repo for testing
function createMockRepo(): Repo {
	return {
		url: "https://github.com/test/repo",
		localPath: "/tmp/test-repo",
		cachePath: "/tmp/cache",
		commitish: "abc123",
		forge: {
			name: "github",
			buildCloneUrl: (url: string) => url,
		},
	};
}

// Mock stream that returns a simple text response
function createMockStreamResult() {
	const events: { type: string; delta?: string }[] = [{ type: "text_delta", delta: "Hello world" }];

	return {
		[Symbol.asyncIterator]: async function* () {
			for (const event of events) {
				yield event;
			}
		},
		result: async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Hello world" }],
			usage: { input: 10, output: 5, totalTokens: 15 },
			timestamp: Date.now(),
			api: "test",
			provider: "test",
			model: "test",
			stopReason: "end_turn",
		}),
	};
}

function createToolCallStreamResult(
	toolCalls: { name: string; arguments: Record<string, unknown> }[] = [{ name: "rg", arguments: { pattern: "test" } }],
) {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (let i = 0; i < toolCalls.length; i++) {
				const tc = toolCalls[i];
				yield {
					type: "toolcall_delta",
					delta: "",
					contentIndex: i,
					partial: { content: toolCalls.map((t) => ({ type: "toolCall", name: t.name })) },
				};
				yield {
					type: "toolcall_end",
					contentIndex: i,
					toolCall: { name: tc?.name, arguments: tc?.arguments },
				};
			}
		},
		result: async () => ({
			role: "assistant" as const,
			content: toolCalls.map((tc, i) => ({
				type: "toolCall" as const,
				id: `tc${i}`,
				name: tc.name,
				arguments: tc.arguments,
			})),
			usage: { input: 100, output: 30, totalTokens: 130 },
			timestamp: Date.now(),
			api: "test",
			provider: "test",
			model: "test",
			stopReason: "tool_use",
		}),
	};
}

function createMockStream(): SessionConfig["stream"] {
	return (() => createMockStreamResult()) as unknown as SessionConfig["stream"];
}

/** Minimal tool stubs matching the names used by createToolCallStreamResult. */
const mockTools = [
	{ name: "rg", description: "search", parameters: {} },
	{ name: "fd", description: "find", parameters: {} },
	{ name: "read", description: "read", parameters: {} },
	{ name: "ls", description: "list", parameters: {} },
	{ name: "git", description: "git", parameters: {} },
] as SessionConfig["tools"];

// Mock config for testing
function createMockConfig(overrides?: Partial<SessionConfig>): SessionConfig {
	return {
		model: {} as Model<Api>, // Mock model - not used in these tests
		systemPrompt: "You are a test assistant",
		tools: mockTools,
		maxIterations: 5,
		executeTool: async () => "mock result",
		logger: nullLogger, // Suppress logging in tests by default
		stream: createMockStream(),
		...overrides,
	};
}

describe("Session", () => {
	describe("constructor", () => {
		test("creates session with unique id", () => {
			const session = new Session(createMockRepo(), createMockConfig());
			expect(typeof session.id).toBe("string");
			expect(session.id).not.toBe("");
		});

		test("creates session with provided repo", () => {
			const session = new Session(createMockRepo(), createMockConfig());
			expect(session.repo).toBeDefined();
		});

		test("creates sessions with different ids", () => {
			const s1 = new Session(createMockRepo(), createMockConfig());
			const s2 = new Session(createMockRepo(), createMockConfig());
			expect(s1.id).not.toBe(s2.id);
		});
	});

	describe("close", () => {
		test("can be called multiple times without error", () => {
			const session = new Session(createMockRepo(), createMockConfig());
			session.close();
			session.close();
			session.close();
		});

		test("close() logs one error with the 'session cleanup failed' label and forwarded details when cleanup fails", async () => {
			const { logger, errors } = createCapturingLogger();
			const session = new Session(createMockRepo(), createMockConfig({ logger }));
			await session.close();

			expect(errors).toHaveLength(1);
			const [entry] = errors;
			expect(entry?.label).toBe("session cleanup failed");
			expect(entry?.payload).toBeDefined();
			expect(typeof entry?.payload).toBe("object");
			expect(entry?.payload).not.toBeNull();
		});

		test("ask throws synchronously after close", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.close();
			expect(() => session.ask("test")).toThrow(`Session ${session.id} is closed`);
		});
	});

	describe("ask", () => {
		test(".result() returns a TurnResult with correct prompt and text", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			const result = await session.ask("What is 2+2?").result();

			expect(result.prompt).toBe("What is 2+2?");
			expect(result.id).toBeTruthy();
			expect(result.error).toBeNull();
			const textSteps = result.steps.filter((s) => s.type === "text");
			expect(textSteps.length).toBeGreaterThan(0);
		});

		test("iterating yields turn_start and turn_end events", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			const stream = session.ask("Hello");

			const events: { type: string }[] = [];
			for await (const event of stream) {
				events.push({ type: event.type });
			}

			expect(events[0]?.type).toBe("turn_start");
			expect(events[events.length - 1]?.type).toBe("turn_end");
		});

		test("tool calls produce tool_result events and steps", async () => {
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					return createToolCallStreamResult([{ name: "rg", arguments: { pattern: "test" } }]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({
					stream: customStream,
					executeTool: async () => "search results",
				}),
			);

			const result = await session.ask("Search").result();

			const toolSteps = result.steps.filter((s) => s.type === "tool_call");
			expect(toolSteps.length).toBeGreaterThan(0);
			if (toolSteps[0]?.type === "tool_call") {
				expect(toolSteps[0].name).toBe("rg");
				expect(toolSteps[0].output).toBe("search results");
			}
		});

		test("error conditions produce TurnResult with .error set", async () => {
			const customStream = (() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "error", error: { errorMessage: "API error" } };
				},
				result: async () => createMockStreamResult().result(),
			})) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: customStream }));
			const result = await session.ask("Test").result();

			expect(result.error).not.toBeNull();
			expect(result.error?.errorType).toBe("provider_error");
		});

		test("max iterations error produces TurnResult with .error set", async () => {
			const customStream = (() =>
				createToolCallStreamResult([
					{ name: "rg", arguments: { pattern: "test" } },
				])) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ maxIterations: 2, stream: customStream }));
			const result = await session.ask("Do something").result();

			expect(result.error).not.toBeNull();
			expect(result.error?.errorType).toBe("max_iterations");
		});

		test("uses injected stream function", async () => {
			let streamCalled = false;
			const customStream = (() => {
				streamCalled = true;
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: customStream }));
			await session.ask("Test").result();
			expect(streamCalled).toBe(true);
		});

		test("adaptive thinking uses stream() with thinkingEnabled", async () => {
			let capturedOptions: unknown;
			let streamCalled = false;
			let streamSimpleCalled = false;
			const customStream = ((_model: unknown, _context: unknown, options?: unknown) => {
				streamCalled = true;
				capturedOptions = options;
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];
			const customStreamSimple = ((_model: unknown, _context: unknown, _options?: unknown) => {
				streamSimpleCalled = true;
				return createMockStreamResult();
			}) as unknown as SessionConfig["streamSimple"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({ stream: customStream, streamSimple: customStreamSimple, thinking: { type: "adaptive" } }),
			);

			await session.ask("Test").result();
			expect(streamCalled).toBe(true);
			expect(streamSimpleCalled).toBe(false);
			expect(capturedOptions).toEqual({ thinkingEnabled: true });
		});

		test("effort-based thinking uses streamSimple() with reasoning option", async () => {
			let capturedOptions: unknown;
			let streamSimpleCalled = false;
			const customStream = (() => createMockStreamResult()) as unknown as SessionConfig["stream"];
			const customStreamSimple = ((_model: unknown, _context: unknown, options?: unknown) => {
				streamSimpleCalled = true;
				capturedOptions = options;
				return createMockStreamResult();
			}) as unknown as SessionConfig["streamSimple"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({ stream: customStream, streamSimple: customStreamSimple, thinking: { effort: "high" } }),
			);

			await session.ask("Test").result();
			expect(streamSimpleCalled).toBe(true);
			expect(capturedOptions).toEqual({ reasoning: "high" });
		});

		test("concurrent ask() calls are serialized", async () => {
			const order: string[] = [];
			let streamCalls = 0;

			const customStream = (() => {
				streamCalls++;
				const n = streamCalls;
				return {
					[Symbol.asyncIterator]: async function* () {
						order.push(`start-${n}`);
						await Bun.sleep(30);
						order.push(`end-${n}`);
						yield { type: "text_delta", delta: `r${n}` };
					},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text" as const, text: `r${n}` }],
						usage: { input: 10, output: 5, totalTokens: 15 },
						timestamp: Date.now(),
						api: "test",
						provider: "test",
						model: "test",
						stopReason: "end_turn",
					}),
				};
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: customStream }));

			const s1 = session.ask("q1");
			const s2 = session.ask("q2");
			await Promise.all([s1.result(), s2.result()]);

			expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
		});
	});

	describe("getTurns / getTurn", () => {
		test("getTurns() returns empty array initially", () => {
			const session = new Session(createMockRepo(), createMockConfig());
			expect(session.getTurns()).toEqual([]);
		});

		test("after one ask, getTurns() has one TurnResult", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello").result();

			const turns = session.getTurns();
			expect(turns).toHaveLength(1);
			expect(turns[0]?.prompt).toBe("Hello");
		});

		test("after multiple asks, getTurns() accumulates in order", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("First").result();
			await session.ask("Second").result();
			await session.ask("Third").result();

			const turns = session.getTurns();
			expect(turns).toHaveLength(3);
			expect(turns[0]?.prompt).toBe("First");
			expect(turns[1]?.prompt).toBe("Second");
			expect(turns[2]?.prompt).toBe("Third");
		});

		test("getTurn(id) finds the right turn", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello").result();
			const id = session.getTurns()[0]?.id ?? "";
			expect(session.getTurn(id)?.prompt).toBe("Hello");
		});

		test("getTurn() returns null for unknown id", () => {
			const session = new Session(createMockRepo(), createMockConfig());
			expect(session.getTurn("nonexistent")).toBeNull();
		});

		test("turns are recorded after iteration without .result()", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			for await (const _event of session.ask("Hello")) {
				// consume all events
			}
			expect(session.getTurns()).toHaveLength(1);
		});
	});

	describe("afterTurn branching", () => {
		test("afterTurn branches from the specified turn", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("First").result();
			await session.ask("Second").result();

			const firstTurnId = session.getTurns()[0]?.id ?? "";
			await session.ask("Branched", { afterTurn: firstTurnId }).result();

			expect(session.getTurns()).toHaveLength(3);
			expect(session.getTurns()[2]?.prompt).toBe("Branched");
		});

		test("afterTurn with unknown id throws synchronously", () => {
			const session = new Session(createMockRepo(), createMockConfig());
			expect(() => session.ask("test", { afterTurn: "nonexistent" })).toThrow("Turn not found: nonexistent");
		});

		test("all turns preserved after branching (append-only)", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Turn 1").result();
			await session.ask("Turn 2").result();
			await session.ask("Turn 3").result();

			const t1Id = session.getTurns()[0]?.id ?? "";
			await session.ask("Branch from 1", { afterTurn: t1Id }).result();

			const turns = session.getTurns();
			expect(turns).toHaveLength(4);
			expect(turns.map((t) => t.prompt)).toEqual(["Turn 1", "Turn 2", "Turn 3", "Branch from 1"]);
		});
	});

	describe("per-turn overrides", () => {
		test("maxIterations override limits iterations for this turn", async () => {
			const customStream = (() =>
				createToolCallStreamResult([
					{ name: "rg", arguments: { pattern: "test" } },
				])) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ maxIterations: 10, stream: customStream }));
			const result = await session.ask("Do something", { maxIterations: 1 }).result();

			const errorSteps = result.steps.filter((s) => s.type === "error");
			expect(errorSteps.length).toBeGreaterThan(0);
		});

		test("thinking override changes stream function used", async () => {
			let streamSimpleCalled = false;
			const customStreamSimple = ((_model: unknown, _context: unknown, _options?: unknown) => {
				streamSimpleCalled = true;
				return createMockStreamResult();
			}) as unknown as SessionConfig["streamSimple"];

			const session = new Session(createMockRepo(), createMockConfig({ streamSimple: customStreamSimple }));
			await session.ask("Test", { thinking: { effort: "high" } }).result();
			expect(streamSimpleCalled).toBe(true);
		});

		test("signal abort cancels the turn before first iteration", async () => {
			const controller = new AbortController();
			controller.abort();

			const session = new Session(createMockRepo(), createMockConfig());
			const result = await session.ask("Test", { signal: controller.signal }).result();

			expect(result.error).not.toBeNull();
			expect(result.error?.errorType).toBe("aborted");
		});

		test("signal abort cancels the turn between iterations", async () => {
			const controller = new AbortController();
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					controller.abort();
					return createToolCallStreamResult([{ name: "rg", arguments: { pattern: "test" } }]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: customStream }));
			const result = await session.ask("Test", { signal: controller.signal }).result();

			const errorSteps = result.steps.filter((s) => s.type === "error");
			expect(errorSteps.length).toBeGreaterThan(0);
		});
	});

	describe("tool-call ID correlation", () => {
		test("tool_use_start, tool_use_end, and tool_result share consistent IDs across the stream", async () => {
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					return createToolCallStreamResult([{ name: "rg", arguments: { pattern: "test" } }]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({
					stream: customStream,
					executeTool: async () => "search results",
				}),
			);

			const stream = session.ask("Search");
			const events: import("../src/types").StreamEvent[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const toolStartEvents = events.filter((e) => e.type === "tool_use_start");
			const toolEndEvents = events.filter((e) => e.type === "tool_use_end");
			const toolResultEvents = events.filter((e) => e.type === "tool_result");

			expect(toolStartEvents).toHaveLength(1);
			expect(toolEndEvents).toHaveLength(1);
			expect(toolResultEvents).toHaveLength(1);

			// All three events should share the same toolCallId
			const startId = (toolStartEvents[0] as import("../src/types").ToolUseStart).toolCallId;
			const endId = (toolEndEvents[0] as import("../src/types").ToolUseEnd).toolCallId;
			const resultId = (toolResultEvents[0] as import("../src/types").ToolResult).toolCallId;

			expect(startId).toBe(endId);
			expect(endId).toBe(resultId);

			// And the TurnResult should have params populated
			const result = await stream.result();
			const toolStep = result.steps.find((s) => s.type === "tool_call");
			expect(toolStep).toBeDefined();
			if (toolStep?.type === "tool_call") {
				expect(toolStep.params).toEqual({ pattern: "test" });
				expect(toolStep.output).toBe("search results");
			}
		});
	});

	describe("usage and iteration tracking", () => {
		test("TurnResult.usage reflects non-zero token counts from the response", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			const result = await session.ask("Hello").result();

			// The mock response returns usage: { input: 10, output: 5, totalTokens: 15 }
			expect(result.usage.inputTokens).toBe(10);
			expect(result.usage.outputTokens).toBe(5);
			expect(result.usage.totalTokens).toBe(15);
		});

		test("iteration_start steps are present in the TurnResult", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			const result = await session.ask("Hello").result();

			const iterSteps = result.steps.filter((s) => s.type === "iteration_start");
			expect(iterSteps).toHaveLength(1);
			if (iterSteps[0]?.type === "iteration_start") {
				expect(iterSteps[0].index).toBe(0);
			}
		});

		test("multi-iteration turn accumulates usage and iteration_start steps", async () => {
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls <= 2) {
					return createToolCallStreamResult([{ name: "rg", arguments: { pattern: "test" } }]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({
					stream: customStream,
					executeTool: async () => "result",
				}),
			);

			const result = await session.ask("Multi").result();

			// 3 iterations: 2 tool-call + 1 final text
			const iterSteps = result.steps.filter((s) => s.type === "iteration_start");
			expect(iterSteps).toHaveLength(3);
			expect(iterSteps.map((s) => s.type === "iteration_start" && s.index)).toEqual([0, 1, 2]);

			// Usage should be accumulated across all 3 iterations
			expect(result.usage.inputTokens).toBeGreaterThan(0);
			expect(result.usage.outputTokens).toBeGreaterThan(0);
		});
	});

	describe("TurnMetadata reflects per-turn overrides", () => {
		test("metadata.config.maxIterations matches the per-turn override", async () => {
			const customStream = (() =>
				createToolCallStreamResult([
					{ name: "rg", arguments: { pattern: "test" } },
				])) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ maxIterations: 10, stream: customStream }));
			const result = await session.ask("Do something", { maxIterations: 1 }).result();

			expect(result.metadata.config.maxIterations).toBe(1);
		});

		test("metadata.config.thinkingConfig matches the per-turn override", async () => {
			const customStreamSimple = ((_model: unknown, _context: unknown, _options?: unknown) => {
				return createMockStreamResult();
			}) as unknown as SessionConfig["streamSimple"];

			const session = new Session(createMockRepo(), createMockConfig({ streamSimple: customStreamSimple }));
			const result = await session.ask("Test", { thinking: { effort: "high" } }).result();

			expect(result.metadata.config.thinkingConfig).toEqual({ effort: "high" });
		});

		test("metadata uses session defaults when no per-turn overrides are given", async () => {
			const session = new Session(
				createMockRepo(),
				createMockConfig({ maxIterations: 7, thinking: { type: "adaptive" } }),
			);
			const result = await session.ask("Hello").result();

			expect(result.metadata.config.maxIterations).toBe(7);
			expect(result.metadata.config.thinkingConfig).toEqual({ type: "adaptive" });
		});
	});

	describe("structured error types", () => {
		test("abort yields error with errorType 'aborted' and retryability 'no'", async () => {
			const controller = new AbortController();
			controller.abort();

			const session = new Session(createMockRepo(), createMockConfig());
			const result = await session.ask("Test", { signal: controller.signal }).result();

			expect(result.error?.errorType).toBe("aborted");
			expect(result.error?.retryability).toBe("no");
		});

		test("max iterations yields error with errorType 'max_iterations' and retryability 'no'", async () => {
			const customStream = (() =>
				createToolCallStreamResult([
					{ name: "rg", arguments: { pattern: "test" } },
				])) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ maxIterations: 1, stream: customStream }));
			const result = await session.ask("Do something").result();

			expect(result.error?.errorType).toBe("max_iterations");
			expect(result.error?.retryability).toBe("no");
		});

		test("provider error yields errorType 'provider_error'", async () => {
			const customStream = (() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "error", error: { errorMessage: "API error" } };
				},
				result: async () => createMockStreamResult().result(),
			})) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: customStream }));
			const result = await session.ask("Test").result();

			expect(result.error?.errorType).toBe("provider_error");
			expect(result.error?.retryability).toBe("unknown");
		});

		test("empty response yields errorType 'empty_response' and retryability 'yes'", async () => {
			const customStream = (() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "text_delta", delta: "" };
				},
				result: async () => ({
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "" }],
					usage: { input: 10, output: 0, totalTokens: 10 },
					timestamp: Date.now(),
					api: "test",
					provider: "test",
					model: "test",
					stopReason: "end_turn",
				}),
			})) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: customStream }));
			const result = await session.ask("Test").result();

			expect(result.error?.errorType).toBe("empty_response");
			expect(result.error?.retryability).toBe("yes");
		});

		test("error steps include errorType and source derived from errorType", async () => {
			const controller = new AbortController();
			controller.abort();

			const session = new Session(createMockRepo(), createMockConfig());
			const result = await session.ask("Test", { signal: controller.signal }).result();

			const errorSteps = result.steps.filter((s) => s.type === "error");
			expect(errorSteps).toHaveLength(1);
			if (errorSteps[0]?.type === "error") {
				expect(errorSteps[0].errorType).toBe("aborted");
				expect(errorSteps[0].source).toBe("library");
				expect(errorSteps[0].retryability).toBe("no");
			}
		});
	});

	describe("initialTurns", () => {
		/** Helper to create a TurnResult for seeding. */
		function makeSeedTurn(
			id: string,
			prompt: string,
			steps: import("../src/types").Step[] = [{ type: "text", text: `Response to: ${prompt}`, role: "assistant" }],
		): import("../src/types").TurnResult {
			return {
				id,
				prompt,
				steps,
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				metadata: {
					iterations: 1,
					latencyMs: 100,
					model: { provider: "test", id: "test-model" },
					repo: { url: "https://github.com/test/repo", commitish: "abc123" },
					config: { maxIterations: 10 },
				},
				error: null,
				startedAt: Date.now() - 10000,
				endedAt: Date.now() - 9000,
			};
		}

		test("getTurns() returns initial turns", () => {
			const seedTurns = [makeSeedTurn("seed-1", "Hello"), makeSeedTurn("seed-2", "World")];
			const session = new Session(createMockRepo(), createMockConfig({ initialTurns: seedTurns }));

			const turns = session.getTurns();
			expect(turns).toHaveLength(2);
			expect(turns[0]?.id).toBe("seed-1");
			expect(turns[0]?.prompt).toBe("Hello");
			expect(turns[1]?.id).toBe("seed-2");
			expect(turns[1]?.prompt).toBe("World");
		});

		test("getTurn(id) finds initial turns by ID", () => {
			const seedTurns = [makeSeedTurn("seed-1", "Hello")];
			const session = new Session(createMockRepo(), createMockConfig({ initialTurns: seedTurns }));

			expect(session.getTurn("seed-1")?.prompt).toBe("Hello");
			expect(session.getTurn("nonexistent")).toBeNull();
		});

		test("ask() after initialTurns accumulates turns", async () => {
			const seedTurns = [makeSeedTurn("seed-1", "Prior question")];
			const session = new Session(createMockRepo(), createMockConfig({ initialTurns: seedTurns }));

			await session.ask("New question").result();

			const turns = session.getTurns();
			expect(turns).toHaveLength(2);
			expect(turns[0]?.prompt).toBe("Prior question");
			expect(turns[1]?.prompt).toBe("New question");
		});

		test("afterTurn branching works with initial turn IDs", async () => {
			const seedTurns = [makeSeedTurn("seed-1", "First"), makeSeedTurn("seed-2", "Second")];
			const session = new Session(createMockRepo(), createMockConfig({ initialTurns: seedTurns }));

			// Branch from the first seed turn
			await session.ask("Branched", { afterTurn: "seed-1" }).result();

			const turns = session.getTurns();
			expect(turns).toHaveLength(3);
			expect(turns[2]?.prompt).toBe("Branched");
		});

		test("empty initialTurns is equivalent to no initialTurns", () => {
			const session = new Session(createMockRepo(), createMockConfig({ initialTurns: [] }));
			expect(session.getTurns()).toEqual([]);
		});
	});
});

describe("classifyResponse", () => {
	function makeResponse(content: AssistantMessage["content"]): AssistantMessage {
		// classifyResponse only reads `content`; other fields are filled for shape completeness.
		return {
			role: "assistant",
			content,
			timestamp: Date.now(),
			api: "test",
			provider: "test",
			model: "test",
			stopReason: "end_turn",
		} as unknown as AssistantMessage;
	}

	test("tool calls take precedence, even when text is also present", () => {
		const r = makeResponse([
			{ type: "text", text: "Looking up..." },
			{ type: "toolCall", id: "tc1", name: "rg", arguments: { pattern: "x" } },
		]);
		const c = classifyResponse(r);
		expect(c.kind).toBe("tool_calls");
		if (c.kind === "tool_calls") {
			expect(c.toolCalls).toHaveLength(1);
			expect(c.toolCalls[0]?.name).toBe("rg");
		}
	});

	test("multiple tool calls all surface in order", () => {
		const r = makeResponse([
			{ type: "toolCall", id: "a", name: "fd", arguments: {} },
			{ type: "toolCall", id: "b", name: "rg", arguments: {} },
		]);
		const c = classifyResponse(r);
		expect(c.kind).toBe("tool_calls");
		if (c.kind === "tool_calls") {
			expect(c.toolCalls.map((t) => t.id)).toEqual(["a", "b"]);
		}
	});

	test("text-only response with content classifies as final", () => {
		const r = makeResponse([{ type: "text", text: "The answer is 42." }]);
		const c = classifyResponse(r);
		expect(c).toEqual({ kind: "final", text: "The answer is 42." });
	});

	test("multiple text blocks are joined with newlines", () => {
		const r = makeResponse([
			{ type: "text", text: "Line one" },
			{ type: "text", text: "Line two" },
		]);
		const c = classifyResponse(r);
		expect(c).toEqual({ kind: "final", text: "Line one\nLine two" });
	});

	test("no content at all classifies as empty", () => {
		const r = makeResponse([]);
		expect(classifyResponse(r)).toEqual({ kind: "empty" });
	});

	test("whitespace-only text classifies as empty", () => {
		const r = makeResponse([{ type: "text", text: "   \n\t  " }]);
		expect(classifyResponse(r)).toEqual({ kind: "empty" });
	});
});
