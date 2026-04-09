import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Repo } from "../src/forge";
import { type Logger, nullLogger } from "../src/logger";
import { type Message, Session, type SessionConfig } from "../src/session";

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
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			expect(typeof session.id).toBe("string");
			expect(session.id).not.toBe("");
		});

		test("creates session with provided repo", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			expect(session.repo).toBe(repo);
		});

		test("creates sessions with different ids", () => {
			const repo = createMockRepo();
			const session1 = new Session(repo, createMockConfig());
			const session2 = new Session(repo, createMockConfig());

			expect(session1.id).not.toBe(session2.id);
		});
	});

	describe("getMessages / replaceMessages", () => {
		test("starts with empty messages", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			expect(session.getMessages()).toEqual([]);
		});

		test("replaceMessages updates the message list", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			const messages = [
				{ role: "user" as const, content: "Hello", timestamp: Date.now() },
				{ role: "user" as const, content: "Follow up", timestamp: Date.now() },
			];

			session.replaceMessages(messages);

			expect(session.getMessages()).toEqual(messages);
		});

		test("after ask(), messages contain both user and assistant messages", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello");
			const messages = session.getMessages();
			expect(messages.length).toBe(2); // user + assistant
			expect(messages[0]?.role).toBe("user");
			expect(messages[1]?.role).toBe("assistant");
		});

		test("multi-turn ask() accumulates messages correctly", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("First question");
			await session.ask("Second question");
			await session.ask("Third question");
			const messages = session.getMessages();
			// Each ask adds 1 user + 1 assistant = 2 messages per turn
			expect(messages.length).toBe(6);
		});

		test("getMessages() returns history after close()", async () => {
			const { logger } = createCapturingLogger();
			const session = new Session(createMockRepo(), createMockConfig({ logger }));
			await session.ask("Hello");
			const messagesBefore = session.getMessages().length;
			await session.close();
			const messagesAfter = session.getMessages();
			expect(messagesAfter.length).toBe(messagesBefore);
			expect(messagesAfter[0]?.content).toBe("Hello");
		});

		test("replaceMessages overwrites existing messages", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			const messages1 = [{ role: "user" as const, content: "First", timestamp: Date.now() }];
			const messages2 = [{ role: "user" as const, content: "Second", timestamp: Date.now() }];

			session.replaceMessages(messages1);
			session.replaceMessages(messages2);

			expect(session.getMessages()).toEqual(messages2);
		});
	});

	describe("close", () => {
		test("can be called multiple times without error", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			// Should not throw
			session.close();
			session.close();
			session.close();
		});

		test("close() attempts worktree cleanup and logs on failure", async () => {
			const { logger, errors } = createCapturingLogger();
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig({ logger }));
			await session.close();
			// cleanupWorktree fails because /tmp/test-repo doesn't exist, so error is logged
			expect(errors.some((e) => e.includes("Failed to cleanup worktree"))).toBe(true);
		});

		test("ask throws after close", async () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			session.close();

			expect(session.ask("test")).rejects.toThrow(`Session ${session.id} is closed`);
		});
	});

	describe("logger", () => {
		test("uses nullLogger by default in tests (no console output)", () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			// If we got here without console spam, nullLogger is working
			expect(session).toBeDefined();
		});

		test("accepts custom logger via config", () => {
			const { logger, logs, errors } = createCapturingLogger();
			const repo = createMockRepo();
			const _session = new Session(repo, createMockConfig({ logger }));

			// Logger is injected but won't be called until ask() runs
			// This test verifies the injection mechanism works
			expect(logs).toEqual([]);
			expect(errors).toEqual([]);
		});
	});

	describe("ask", () => {
		test("returns response from mock stream", async () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			const result = await session.ask("What is 2+2?");

			expect(result.prompt).toBe("What is 2+2?");
			expect(result.response).toBe("Hello world");
			expect(result.error).toBeNull();
			expect(result.toolCalls).toEqual([]);
			expect(result.usage.inputTokens).toBe(10);
			expect(result.usage.outputTokens).toBe(5);
		});

		test("adds user message to context", async () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			await session.ask("Test question");

			const messages = session.getMessages();
			expect(messages.length).toBe(2);
			expect(messages[0]?.role).toBe("user");
			expect(messages[0]?.content).toBe("Test question");
		});

		test("rejecting tool execution is fed back as an error tool result", async () => {
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					return createToolCallStreamResult([{ name: "rg", arguments: { pattern: "needle" } }]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const repo = createMockRepo();
			const session = new Session(
				repo,
				createMockConfig({
					stream: customStream,
					executeTool: async () => {
						throw new Error("tool crashed");
					},
				}),
			);

			const result = await session.ask("Find needle");
			expect(result.response).toBe("Hello world");
			expect(streamCalls).toBe(2);

			const toolResults = session.getMessages().filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]?.isError).toBe(true);
			expect((toolResults[0]?.content[0] as { text?: string } | undefined)?.text).toBe(
				"[ERROR] Tool execution failed for rg: tool crashed",
			);
		});

		test("uses injected stream function", async () => {
			let streamCalled = false;
			const customStream = (() => {
				streamCalled = true;
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig({ stream: customStream }));

			await session.ask("Test");

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

			const repo = createMockRepo();
			const session = new Session(
				repo,
				createMockConfig({
					stream: customStream,
					streamSimple: customStreamSimple,
					thinking: { type: "adaptive" },
				}),
			);

			await session.ask("Test");

			expect(streamCalled).toBe(true);
			expect(streamSimpleCalled).toBe(false);
			expect(capturedOptions).toEqual({ thinkingEnabled: true });
		});

		test("adaptive thinking with effort passes both to stream()", async () => {
			let capturedOptions: unknown;
			const customStream = ((_model: unknown, _context: unknown, options?: unknown) => {
				capturedOptions = options;
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const repo = createMockRepo();
			const session = new Session(
				repo,
				createMockConfig({
					stream: customStream,
					thinking: { type: "adaptive", effort: "medium" },
				}),
			);

			await session.ask("Test");

			expect(capturedOptions).toEqual({ thinkingEnabled: true, effort: "medium" });
		});

		test("effort-based thinking uses streamSimple() with reasoning option", async () => {
			let capturedOptions: unknown;
			let streamCalled = false;
			let streamSimpleCalled = false;
			const customStream = ((_model: unknown, _context: unknown, _options?: unknown) => {
				streamCalled = true;
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];
			const customStreamSimple = ((_model: unknown, _context: unknown, options?: unknown) => {
				streamSimpleCalled = true;
				capturedOptions = options;
				return createMockStreamResult();
			}) as unknown as SessionConfig["streamSimple"];

			const repo = createMockRepo();
			const session = new Session(
				repo,
				createMockConfig({
					stream: customStream,
					streamSimple: customStreamSimple,
					thinking: { effort: "high" },
				}),
			);

			await session.ask("Test");

			expect(streamCalled).toBe(false);
			expect(streamSimpleCalled).toBe(true);
			expect(capturedOptions).toEqual({ reasoning: "high" });
		});

		test("effort-based thinking passes budgetOverrides as thinkingBudgets", async () => {
			let capturedOptions: unknown;
			const customStreamSimple = ((_model: unknown, _context: unknown, options?: unknown) => {
				capturedOptions = options;
				return createMockStreamResult();
			}) as unknown as SessionConfig["streamSimple"];

			const repo = createMockRepo();
			const session = new Session(
				repo,
				createMockConfig({
					streamSimple: customStreamSimple,
					thinking: { effort: "medium", budgetOverrides: { medium: 8000 } },
				}),
			);

			await session.ask("Test");

			expect(capturedOptions).toEqual({ reasoning: "medium", thinkingBudgets: { medium: 8000 } });
		});

		test("no thinking config uses stream() with no options", async () => {
			let capturedOptions: unknown = "sentinel";
			const customStream = ((_model: unknown, _context: unknown, options?: unknown) => {
				capturedOptions = options;
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig({ stream: customStream }));

			await session.ask("Test");

			expect(capturedOptions).toBeUndefined();
		});

		test("tool calls are dispatched to config.executeTool", async () => {
			const executedTools: { name: string; args: Record<string, unknown> }[] = [];
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
					executeTool: async (name, args) => {
						executedTools.push({ name, args });
						return "tool output";
					},
				}),
			);

			await session.ask("Search for test");
			expect(executedTools).toHaveLength(1);
			expect(executedTools[0]?.name).toBe("rg");
			expect(executedTools[0]?.args).toEqual({ pattern: "test" });
		});

		test("tool results appear as toolResult messages in history", async () => {
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
					executeTool: async () => "search results here",
				}),
			);

			await session.ask("Search");
			const toolResults = session.getMessages().filter((m) => m.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0]?.toolName).toBe("rg");
			expect((toolResults[0]?.content[0] as { text?: string })?.text).toBe("search results here");
			expect(toolResults[0]?.isError).toBe(false);
		});

		test("result.toolCalls records all tool calls with enriched fields", async () => {
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					return createToolCallStreamResult([
						{ name: "rg", arguments: { pattern: "foo" } },
						{ name: "fd", arguments: { pattern: "bar" } },
					]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({
					stream: customStream,
					executeTool: async () => "tool output",
				}),
			);

			const result = await session.ask("Find files");
			expect(result.toolCalls).toHaveLength(2);

			const tc0 = result.toolCalls[0] as (typeof result.toolCalls)[0];
			expect(tc0.id).toBe("tc0");
			expect(tc0.name).toBe("rg");
			expect(tc0.arguments).toEqual({ pattern: "foo" });
			expect(tc0.output).toBe("tool output");
			expect(tc0.isError).toBe(false);
			expect(typeof tc0.durationMs).toBe("number");
			expect(tc0.durationMs).toBeGreaterThanOrEqual(0);

			const tc1 = result.toolCalls[1] as (typeof result.toolCalls)[0];
			expect(tc1.id).toBe("tc1");
			expect(tc1.name).toBe("fd");
			expect(tc1.isError).toBe(false);
		});

		test("failed tool call records have isError=true and error output", async () => {
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
					executeTool: async () => {
						throw new Error("tool crashed");
					},
				}),
			);

			const result = await session.ask("Search");
			expect(result.toolCalls).toHaveLength(1);

			const tc = result.toolCalls[0] as (typeof result.toolCalls)[0];
			expect(tc.id).toBe("tc0");
			expect(tc.name).toBe("rg");
			expect(tc.isError).toBe(true);
			expect(tc.output).toContain("tool crashed");
			expect(tc.durationMs).toBeGreaterThanOrEqual(0);
		});

		test("multiple tool calls execute in parallel", async () => {
			const execLog: { name: string; start: number; end: number }[] = [];
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					return createToolCallStreamResult([
						{ name: "tool1", arguments: {} },
						{ name: "tool2", arguments: {} },
						{ name: "tool3", arguments: {} },
					]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({
					stream: customStream,
					tools: [
						{ name: "tool1", description: "", parameters: {} },
						{ name: "tool2", description: "", parameters: {} },
						{ name: "tool3", description: "", parameters: {} },
					] as SessionConfig["tools"],
					executeTool: async (name) => {
						const start = Date.now();
						await Bun.sleep(50);
						execLog.push({ name, start, end: Date.now() });
						return "done";
					},
				}),
			);

			await session.ask("Run tools");

			// Verify all 3 tools executed
			expect(execLog).toHaveLength(3);
			// Verify at least two tools overlapped in time (proves parallelism)
			// Sort by start time and check if any tool started before a previous one ended
			execLog.sort((a, b) => a.start - b.start);
			const hasOverlap = execLog.some((entry, i) => i > 0 && entry.start < (execLog[i - 1]?.end ?? 0));
			expect(hasOverlap).toBe(true);
		});

		test("returns max-iterations error after exhausting iterations", async () => {
			const customStream = (() =>
				createToolCallStreamResult([
					{ name: "rg", arguments: { pattern: "test" } },
				])) as unknown as SessionConfig["stream"];

			const session = new Session(
				createMockRepo(),
				createMockConfig({
					maxIterations: 2,
					stream: customStream,
				}),
			);

			const result = await session.ask("Do something");
			expect(result.response).toContain("Max iterations reached");
			expect(result.error).not.toBeNull();
			expect(result.error?.message).toContain("Max iterations reached");
		});

		test("unknown tool call flows back as error and model can respond", async () => {
			let streamCalls = 0;
			const customStream = (() => {
				streamCalls++;
				if (streamCalls === 1) {
					return createToolCallStreamResult([{ name: "nonexistent_tool", arguments: { foo: "bar" } }]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const executedTools: string[] = [];
			const session = new Session(
				createMockRepo(),
				createMockConfig({
					stream: customStream,
					tools: mockTools,
					executeTool: async (name) => {
						executedTools.push(name);
						return `Unknown tool: ${name}`;
					},
				}),
			);

			const result = await session.ask("Do something");
			// Tool call flowed through to executeTool
			expect(executedTools).toEqual(["nonexistent_tool"]);
			// Model got a second iteration and produced a normal response
			expect(result.response).toBe("Hello world");
		});

		test("usage accumulates across iterations", async () => {
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
					executeTool: async () => "result",
				}),
			);

			const result = await session.ask("Search");
			// Iteration 1: input 100, output 30, total 130
			// Iteration 2: input 10, output 5, total 15
			expect(result.usage.inputTokens).toBe(110);
			expect(result.usage.outputTokens).toBe(35);
			expect(result.usage.totalTokens).toBe(145);
		});

		test("extracts responseEffort from patched AssistantMessage", async () => {
			const mockResult = createMockStreamResult();
			const originalResult = mockResult.result;
			mockResult.result = async () => {
				const msg = await originalResult();
				// Simulate pi-ai patch: outputConfig stashed on AssistantMessage
				(msg as Record<string, unknown>).outputConfig = { effort: "medium" };
				return msg;
			};
			const customStream = (() => mockResult) as unknown as SessionConfig["stream"];

			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig({ stream: customStream }));

			const result = await session.ask("Test");

			expect(result.responseEffort).toBe("medium");
		});
	});

	describe("compaction integration", () => {
		function createLargeContext(): Message[] {
			const bigContent = "x".repeat(400000);
			return [
				{ role: "user", content: bigContent, timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: bigContent }],
					timestamp: Date.now(),
					api: "test",
					provider: "test",
					model: "test",
					stopReason: "end_turn",
					usage: { input: 0, output: 0, totalTokens: 0 },
				} as unknown as Message,
				{ role: "user", content: "second question", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "second answer" }],
					timestamp: Date.now(),
					api: "test",
					provider: "test",
					model: "test",
					stopReason: "end_turn",
					usage: { input: 0, output: 0, totalTokens: 0 },
				} as unknown as Message,
			];
		}

		test("ask() succeeds when compaction is triggered by large context", async () => {
			// Context exceeds compaction threshold (~200k tokens).
			// Compaction may succeed (if mock.module is active from other tests)
			// or fail (if real completeSimple is used with mock model).
			// Either way, ask() must succeed — compaction errors are caught.
			const { logger, logs, errors } = createCapturingLogger();
			const session = new Session(createMockRepo(), createMockConfig({ logger }));
			session.replaceMessages(createLargeContext());

			const result = await session.ask("Hello");
			expect(result.response).toBe("Hello world");
			// Compaction was attempted: either logged success or caught error
			const allOutput = [...logs, ...errors];
			expect(allOutput.some((e) => e.includes("[compaction]"))).toBe(true);
		});

		test("ask() succeeds when context is below compaction threshold", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			session.replaceMessages([{ role: "user", content: "short question", timestamp: Date.now() }]);
			const result = await session.ask("Hello");
			expect(result.response).toBe("Hello world");
		});
	});

	describe("concurrency", () => {
		test("concurrent ask() calls are serialized (q2 waits for q1)", async () => {
			const order: string[] = [];
			let streamCalls = 0;

			const customStream = (() => {
				streamCalls++;
				const n = streamCalls;
				return {
					[Symbol.asyncIterator]: async function* () {
						order.push(`stream-start-${n}`);
						await Bun.sleep(30);
						order.push(`stream-end-${n}`);
						yield { type: "text_delta", delta: `response ${n}` };
					},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text" as const, text: `response ${n}` }],
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

			// Launch both asks concurrently — do NOT await the first
			const p1 = session.ask("q1");
			const p2 = session.ask("q2");
			await Promise.all([p1, p2]);

			// If serialized: q1 fully completes before q2 starts
			expect(order).toEqual(["stream-start-1", "stream-end-1", "stream-start-2", "stream-end-2"]);
		});
	});
});
