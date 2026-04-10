import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Repo } from "../src/forge";
import { type Logger, nullLogger } from "../src/logger";
import { Session, type SessionConfig } from "../src/session";

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

// Helper to create a logger that captures logs
function createCapturingLogger(): { logger: Logger; logs: string[]; errors: string[] } {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		logs,
		errors,
		logger: {
			error(label: string, error: unknown) {
				errors.push(`${label}: ${JSON.stringify(error)}`);
			},
			warn(label: string, content: string) {
				logs.push(`WARN ${label}: ${content}`);
			},
			log(label: string, content: string) {
				logs.push(`${label}: ${content}`);
			},
			info(label: string, content: string) {
				logs.push(`${label}: ${content}`);
			},
			debug(label: string, content: string) {
				logs.push(`DEBUG ${label}: ${content}`);
			},
		},
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

		test("close() attempts worktree cleanup and logs on failure", async () => {
			const { logger, errors } = createCapturingLogger();
			const session = new Session(createMockRepo(), createMockConfig({ logger }));
			await session.close();
			expect(errors.some((e) => e.includes("Failed to cleanup worktree"))).toBe(true);
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
			expect(result.error?.message).toContain("API");
		});

		test("max iterations error produces TurnResult with .error set", async () => {
			const customStream = (() =>
				createToolCallStreamResult([
					{ name: "rg", arguments: { pattern: "test" } },
				])) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ maxIterations: 2, stream: customStream }));
			const result = await session.ask("Do something").result();

			expect(result.error).not.toBeNull();
			expect(result.error?.message).toContain("Max iterations reached");
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
			expect(result.error?.message).toBe("Aborted");
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
});
