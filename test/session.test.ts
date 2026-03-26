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

function createMockStream(): SessionConfig["stream"] {
	return (() => createMockStreamResult()) as unknown as SessionConfig["stream"];
}

// Mock config for testing
function createMockConfig(overrides?: Partial<SessionConfig>): SessionConfig {
	return {
		model: {} as Model<Api>, // Mock model - not used in these tests
		systemPrompt: "You are a test assistant",
		tools: [],
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

			expect(session.id).toBeDefined();
			expect(typeof session.id).toBe("string");
			expect(session.id.length).toBeGreaterThan(0);
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
			expect(result.toolCalls).toEqual([]);
			expect(result.usage.inputTokens).toBe(10);
			expect(result.usage.outputTokens).toBe(5);
		});

		test("adds user message to context", async () => {
			const repo = createMockRepo();
			const session = new Session(repo, createMockConfig());

			await session.ask("Test question");

			const messages = session.getMessages();
			expect(messages.length).toBeGreaterThanOrEqual(1);
			expect(messages[0]?.role).toBe("user");
			expect(messages[0]?.content).toBe("Test question");
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
});
