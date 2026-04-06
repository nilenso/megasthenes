import { beforeEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	type context,
	type Span,
	type SpanAttributes,
	SpanStatusCode,
	type TimeInput,
	type TracerProvider,
	trace,
} from "@opentelemetry/api";
import type { Repo } from "../src/forge";
import { nullLogger } from "../src/logger";
import { Session, type SessionConfig } from "../src/session";

// =============================================================================
// In-memory OTel span recorder
//
// Registers a custom TracerProvider that captures all spans in memory.
// This is the standard OTel testing pattern — we're testing that our code
// emits the right spans, not testing the OTel SDK itself.
// =============================================================================

interface RecordedSpan {
	name: string;
	attributes: Record<string, unknown>;
	status: { code: number; message?: string };
	events: { name: string; attributes?: Record<string, unknown> }[];
	parentSpanId?: string;
	spanId: string;
	ended: boolean;
	exceptions: { message: string }[];
}

/** Minimal in-memory span that records everything for assertions. */
class TestSpan implements Span {
	readonly name: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	attributes: Record<string, unknown> = {};
	status: { code: number; message?: string } = { code: SpanStatusCode.UNSET };
	events: { name: string; attributes?: Record<string, unknown> }[] = [];
	exceptions: { message: string }[] = [];
	ended = false;

	constructor(name: string, spanId: string, parentSpanId?: string) {
		this.name = name;
		this.spanId = spanId;
		this.parentSpanId = parentSpanId;
	}

	spanContext() {
		return {
			traceId: "test-trace-id",
			spanId: this.spanId,
			traceFlags: 1,
		};
	}

	setAttribute(key: string, value: unknown) {
		this.attributes[key] = value;
		return this;
	}

	setAttributes(attrs: Record<string, unknown>) {
		for (const [k, v] of Object.entries(attrs)) {
			this.attributes[k] = v;
		}
		return this;
	}

	setStatus(status: { code: number; message?: string }) {
		this.status = status;
		return this;
	}

	addEvent(name: string, attributesOrStartTime?: SpanAttributes | TimeInput, _startTime?: TimeInput) {
		const attrs =
			attributesOrStartTime !== undefined &&
			typeof attributesOrStartTime === "object" &&
			!Array.isArray(attributesOrStartTime)
				? (attributesOrStartTime as Record<string, unknown>)
				: undefined;
		this.events.push({ name, attributes: attrs });
		return this;
	}

	recordException(exception: unknown) {
		const message = exception instanceof Error ? exception.message : String(exception);
		this.exceptions.push({ message });
		return this;
	}

	updateName(_name: string) {
		return this;
	}
	addLink() {
		return this;
	}
	addLinks() {
		return this;
	}
	isRecording() {
		return !this.ended;
	}
	end() {
		this.ended = true;
	}

	toRecorded(): RecordedSpan {
		return {
			name: this.name,
			attributes: { ...this.attributes },
			status: { ...this.status },
			events: this.events.map((e) => ({ ...e })),
			parentSpanId: this.parentSpanId,
			spanId: this.spanId,
			ended: this.ended,
			exceptions: [...this.exceptions],
		};
	}
}

/** Captures all spans created during a test. */
class SpanRecorder {
	spans: TestSpan[] = [];
	#nextId = 1;

	createSpan(name: string, parentSpanId?: string): TestSpan {
		const span = new TestSpan(name, `span-${this.#nextId++}`, parentSpanId);
		this.spans.push(span);
		return span;
	}

	getSpan(name: string): RecordedSpan | undefined {
		for (let i = this.spans.length - 1; i >= 0; i--) {
			if (this.spans[i]?.name === name) {
				return this.spans[i]?.toRecorded();
			}
		}
		return undefined;
	}

	getSpans(name: string): RecordedSpan[] {
		return this.spans.filter((s) => s.name === name).map((s) => s.toRecorded());
	}

	allRecorded(): RecordedSpan[] {
		return this.spans.map((s) => s.toRecorded());
	}

	clear() {
		this.spans = [];
		this.#nextId = 1;
	}
}

// Global recorder — installed once via OTel API
const recorder = new SpanRecorder();

// Register a custom TracerProvider that uses our recorder
const testTracerProvider: TracerProvider = {
	getTracer(_name: string, _version?: string, _options?: unknown) {
		return {
			startSpan(name: string, options?: { attributes?: Record<string, unknown> }, ctx?: unknown) {
				// Extract parent span ID from context if available
				let parentSpanId: string | undefined;
				if (ctx) {
					const parentSpan = trace.getSpan(ctx as ReturnType<typeof context.active>);
					if (parentSpan) {
						parentSpanId = parentSpan.spanContext().spanId;
					}
				}

				const span = recorder.createSpan(name, parentSpanId);
				if (options?.attributes) {
					span.setAttributes(options.attributes);
				}
				return span;
			},
			startActiveSpan: (() => {}) as ReturnType<typeof trace.getTracer>["startActiveSpan"],
		};
	},
};

// =============================================================================
// Test helpers
// =============================================================================

function createMockRepo(): Repo {
	return {
		url: "https://github.com/test/repo",
		localPath: "/tmp/test-repo",
		cachePath: "/tmp/cache",
		commitish: "abc123",
		forge: { name: "github", buildCloneUrl: (url: string) => url },
	};
}

function createMockStreamResult(overrides?: Partial<{ content: unknown[]; usage: Record<string, unknown> }>) {
	const content = overrides?.content ?? [{ type: "text" as const, text: "Hello world" }];
	const usage = overrides?.usage ?? { input: 100, output: 50, totalTokens: 150, cacheRead: 80, cacheWrite: 20 };

	return {
		[Symbol.asyncIterator]: async function* () {
			yield { type: "text_delta", delta: "Hello world" };
		},
		result: async () => ({
			role: "assistant" as const,
			content,
			usage,
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

function createErrorStreamResult() {
	return {
		[Symbol.asyncIterator]: async function* () {
			yield { type: "error", error: { errorMessage: "Rate limit exceeded" } };
		},
		result: async () => {
			throw new Error("Stream failed");
		},
	};
}

/** Minimal tool stubs matching the names used by createToolCallStreamResult. */
const mockTools = [
	{ name: "rg", description: "search", parameters: {} },
	{ name: "fd", description: "find", parameters: {} },
	{ name: "read", description: "read", parameters: {} },
	{ name: "ls", description: "list", parameters: {} },
	{ name: "git", description: "git", parameters: {} },
] as SessionConfig["tools"];

function createMockConfig(overrides?: Partial<SessionConfig>): SessionConfig {
	return {
		model: { id: "test-model", provider: "test-provider" } as Model<Api>,
		systemPrompt: "You are a test assistant",
		tools: mockTools,
		maxIterations: 5,
		executeTool: async () => "mock tool result",
		logger: nullLogger,
		stream: (() => createMockStreamResult()) as unknown as SessionConfig["stream"],
		...overrides,
	};
}

function expectSpanErrorDetails(
	span: RecordedSpan | undefined,
	{
		errorType,
		message,
		name = "Error",
		exceptionMessage = message,
		exceptionCount = 1,
	}: {
		errorType: string;
		message: string;
		name?: string;
		exceptionMessage?: string;
		exceptionCount?: number;
	},
) {
	expect(span?.status.code).toBe(SpanStatusCode.ERROR);
	expect(span?.status.message).toBe(message);
	expect(span?.attributes["error.type"]).toBe(errorType);
	expect(span?.attributes["megasthenes.error.name"]).toBe(name);
	expect(span?.attributes["megasthenes.error.message"]).toBe(message);
	expect(span?.exceptions.length).toBe(exceptionCount);
	if (exceptionCount > 0) {
		expect(span?.exceptions[0]?.message).toBe(exceptionMessage);
	}
}

// =============================================================================
// Test suite
// =============================================================================

// Install test tracer provider before all tests
trace.setGlobalTracerProvider(testTracerProvider);

describe("OTel tracing", () => {
	beforeEach(() => {
		recorder.clear();
	});

	// -------------------------------------------------------------------------
	// Root ask span
	// -------------------------------------------------------------------------

	describe("ask span", () => {
		test("creates root span with GenAI attributes", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("What is this?");

			const span = recorder.getSpan("ask");
			expect(span).toBeDefined();
			expect(span?.attributes["gen_ai.operation.name"]).toBe("chat");
			expect(span?.attributes["gen_ai.request.model"]).toBe("test-provider/test-model");
			expect(span?.attributes["megasthenes.session.id"]).toBe(session.id);
			expect(span?.attributes["megasthenes.repo.url"]).toBe("https://github.com/test/repo");
			expect(span?.attributes["megasthenes.repo.commitish"]).toBe("abc123");
			expect(span?.ended).toBe(true);
			expect(span?.status.code).toBe(SpanStatusCode.OK);
		});

		test("emits system prompt as event", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello?");

			const span = recorder.getSpan("ask");
			const sysEvent = span?.events.find((e) => e.name === "gen_ai.system_instructions");
			expect(sysEvent).toBeDefined();
			expect(sysEvent?.attributes?.content).toBe("You are a test assistant");
		});

		test("records usage, link stats, iteration count, and tool call count on completion", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) return createToolCallStreamResult();
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			await session.ask("Hello?");

			const span = recorder.getSpan("ask");
			expect(span?.attributes["gen_ai.usage.input_tokens"]).toBe(200);
			expect(span?.attributes["gen_ai.usage.output_tokens"]).toBe(80);
			expect(span?.attributes["megasthenes.response.total_links"]).toBe(0);
			expect(span?.attributes["megasthenes.response.invalid_links"]).toBe(0);
			expect(span?.attributes["megasthenes.total_iterations"]).toBe(2);
			expect(span?.attributes["megasthenes.total_tool_calls"]).toBe(1);
		});

		test("each ask() creates a separate root span", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("First");
			await session.ask("Second");

			const askSpans = recorder.getSpans("ask");
			expect(askSpans.length).toBe(2);
			expect(askSpans[0]?.attributes["megasthenes.session.id"]).toBe(askSpans[1]?.attributes["megasthenes.session.id"]);
		});
	});

	// -------------------------------------------------------------------------
	// Compaction span
	// -------------------------------------------------------------------------

	describe("compaction span", () => {
		test("emits compaction span as child of ask", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello?");

			const askSpan = recorder.getSpan("ask");
			const compSpan = recorder.getSpan("compaction");
			expect(compSpan).toBeDefined();
			expect(compSpan?.parentSpanId).toBe(askSpan?.spanId);
			expect(compSpan?.attributes["megasthenes.compaction.was_compacted"]).toBe(false);
			expect(compSpan?.ended).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Generation span
	// -------------------------------------------------------------------------

	describe("generation span", () => {
		test("emits gen_ai.chat span with model, provider, and iteration", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello?");

			const genSpan = recorder.getSpan("gen_ai.chat");
			expect(genSpan).toBeDefined();
			expect(genSpan?.attributes["gen_ai.request.model"]).toBe("test-provider/test-model");
			expect(genSpan?.attributes["gen_ai.provider.name"]).toBe("test-provider");
			expect(genSpan?.attributes["megasthenes.iteration"]).toBe(1);
			expect(genSpan?.status.code).toBe(SpanStatusCode.OK);
		});

		test("records stop reason on generation span", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello?");

			const genSpan = recorder.getSpan("gen_ai.chat");
			expect(genSpan?.attributes["gen_ai.response.finish_reason"]).toBe("end_turn");
		});

		test("emits input and output message events", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello?");

			const genSpan = recorder.getSpan("gen_ai.chat");
			const inputEvent = genSpan?.events.find((e) => e.name === "gen_ai.input.messages");
			const outputEvent = genSpan?.events.find((e) => e.name === "gen_ai.output.messages");
			expect(inputEvent).toBeDefined();
			expect(outputEvent).toBeDefined();
			// Input should contain the user question
			expect(inputEvent?.attributes?.content).toContain("Hello?");
		});

		test("records token usage attributes", async () => {
			const session = new Session(createMockRepo(), createMockConfig());
			await session.ask("Hello?");

			const genSpan = recorder.getSpan("gen_ai.chat");
			expect(genSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
			expect(genSpan?.attributes["gen_ai.usage.output_tokens"]).toBe(50);
			expect(genSpan?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(80);
			expect(genSpan?.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(20);
		});

		test("increments iteration across multiple LLM calls", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) return createToolCallStreamResult();
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			await session.ask("Hello?");

			const genSpans = recorder.getSpans("gen_ai.chat");
			expect(genSpans.length).toBe(2);
			expect(genSpans[0]?.attributes["megasthenes.iteration"]).toBe(1);
			expect(genSpans[1]?.attributes["megasthenes.iteration"]).toBe(2);
		});

		test("records exception on stream error", async () => {
			const streamFn = (() => createErrorStreamResult()) as unknown as SessionConfig["stream"];
			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));

			await session.ask("Will fail");

			const genSpan = recorder.getSpan("gen_ai.chat");
			expectSpanErrorDetails(genSpan, {
				errorType: "generation_failed",
				message: "Rate limit exceeded",
			});
		});
	});

	// -------------------------------------------------------------------------
	// Tool span
	// -------------------------------------------------------------------------

	describe("tool span", () => {
		test("emits gen_ai.execute_tool span per tool call", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) return createToolCallStreamResult();
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			await session.ask("Search");

			const toolSpans = recorder.getSpans("gen_ai.execute_tool");
			expect(toolSpans.length).toBe(1);
			expect(toolSpans[0]?.attributes["gen_ai.tool.name"]).toBe("rg");
			expect(toolSpans[0]?.attributes["gen_ai.tool.call.id"]).toBe("tc0");
		});

		test("records tool arguments and result as events", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) return createToolCallStreamResult([{ name: "read", arguments: { path: "src/index.ts" } }]);
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const executeTool = async () => "file contents here";
			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn, executeTool }));
			await session.ask("Read file");

			const toolSpan = recorder.getSpans("gen_ai.execute_tool")[0];
			const argsEvent = toolSpan?.events.find((e) => e.name === "gen_ai.tool.call.arguments");
			const resultEvent = toolSpan?.events.find((e) => e.name === "gen_ai.tool.call.result");
			expect(argsEvent?.attributes?.content).toContain("src/index.ts");
			expect(resultEvent?.attributes?.content).toBe("file contents here");
		});

		test("multiple parallel tool calls each get separate spans", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) {
					return createToolCallStreamResult([
						{ name: "rg", arguments: { pattern: "foo" } },
						{ name: "fd", arguments: { pattern: "bar" } },
					]);
				}
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			await session.ask("Search");

			const toolSpans = recorder.getSpans("gen_ai.execute_tool");
			expect(toolSpans.length).toBe(2);
			const names = toolSpans.map((s) => s.attributes["gen_ai.tool.name"]).sort();
			expect(names).toEqual(["fd", "rg"]);
		});

		test("tool spans are children of the gen_ai.chat span that triggered them", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) return createToolCallStreamResult();
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			await session.ask("Search");

			const chatSpan = recorder.getSpans("gen_ai.chat")[0];
			const toolSpan = recorder.getSpans("gen_ai.execute_tool")[0];
			expect(toolSpan?.parentSpanId).toBe(chatSpan?.spanId);
		});
	});

	// -------------------------------------------------------------------------
	// Error paths
	// -------------------------------------------------------------------------

	describe("error paths", () => {
		test("max iterations ends ask span with error status", async () => {
			const streamFn = (() => createToolCallStreamResult()) as unknown as SessionConfig["stream"];
			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn, maxIterations: 2 }));

			await session.ask("Loop");

			const askSpan = recorder.getSpan("ask");
			expectSpanErrorDetails(askSpan, {
				errorType: "max_iterations_reached",
				message: "max_iterations_reached",
				exceptionCount: 0,
			});
		});

		test("API error ends both generation and ask spans properly", async () => {
			const streamFn = (() => createErrorStreamResult()) as unknown as SessionConfig["stream"];
			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));

			await session.ask("Fail");

			const askSpan = recorder.getSpan("ask");
			const genSpan = recorder.getSpan("gen_ai.chat");

			// Generation ended with error
			expect(genSpan?.status.code).toBe(SpanStatusCode.ERROR);
			expect(genSpan?.attributes["error.type"]).toBe("generation_failed");
			expect(genSpan?.attributes["megasthenes.error.message"]).toBe("Rate limit exceeded");
			expect(genSpan?.ended).toBe(true);

			// Ask span still ended (no orphan)
			expect(askSpan?.ended).toBe(true);
			expect(askSpan?.status.code).toBe(SpanStatusCode.OK); // ask succeeded in returning a result
		});

		test("tool execution error ends tool span with error and still lets ask complete", async () => {
			let callCount = 0;
			const streamFn = (() => {
				callCount++;
				if (callCount === 1) return createToolCallStreamResult();
				return createMockStreamResult();
			}) as unknown as SessionConfig["stream"];

			const executeTool = async () => {
				throw new Error("tool crashed");
			};

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn, executeTool }));

			const result = await session.ask("Boom");
			expect(result.response).toBe("Hello world");

			// Tool span ended with error
			const toolSpan = recorder.getSpans("gen_ai.execute_tool")[0];
			expectSpanErrorDetails(toolSpan, {
				errorType: "tool_execution_failed",
				message: "tool crashed",
			});
			expect(toolSpan?.ended).toBe(true);
			expect(toolSpan?.events.at(-1)?.name).toBe("gen_ai.tool.call.result");
			expect(toolSpan?.events.at(-1)?.attributes?.content).toBe("[ERROR] Tool execution failed for rg: tool crashed");

			// Ask span still ends successfully after the model gets the tool error as context
			const askSpan = recorder.getSpan("ask");
			expect(askSpan?.status.code).toBe(SpanStatusCode.OK);
			expect(askSpan?.ended).toBe(true);
		});

		test("API error in response records string error as exception on generation span", async () => {
			const streamFn = (() => ({
				[Symbol.asyncIterator]: async function* () {
					yield { type: "text_delta", delta: "" };
				},
				result: async () => ({
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "" }],
					usage: { input: 10, output: 5, totalTokens: 15 },
					timestamp: Date.now(),
					api: "test",
					provider: "test",
					model: "test",
					stopReason: "error",
					errorMessage: "Rate limit exceeded",
				}),
			})) as unknown as SessionConfig["stream"];

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			await session.ask("Fail with API error");

			const genSpan = recorder.getSpan("gen_ai.chat");
			expectSpanErrorDetails(genSpan, {
				errorType: "generation_failed",
				message: "Rate limit exceeded",
			});
			expect(genSpan?.ended).toBe(true);
		});

		test("empty final responses record structured details on the generation span", async () => {
			const streamFn = (() => ({
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

			const session = new Session(createMockRepo(), createMockConfig({ stream: streamFn }));
			const result = await session.ask("Return nothing");

			expect(result.response).toBe("[ERROR: Empty response from API - check API key and credits]");

			const genSpan = recorder.getSpan("gen_ai.chat");
			expectSpanErrorDetails(genSpan, {
				errorType: "generation_failed",
				message: "Empty response from API",
			});
		});

		test("compaction error records structured details on the compaction span", async () => {
			const loggerThatFailsOnCompactionLog = {
				...nullLogger,
				log: (label: string) => {
					if (label === "[compaction]") {
						throw new Error("logger failed during compaction");
					}
				},
			};
			const session = new Session(
				createMockRepo(),
				createMockConfig({
					logger: loggerThatFailsOnCompactionLog,
					stream: (() => createMockStreamResult()) as unknown as SessionConfig["stream"],
				}),
			);
			session.replaceMessages([
				{ role: "user", content: "x".repeat(400_000), timestamp: Date.now() },
				{ role: "user", content: "y".repeat(400_000), timestamp: Date.now() + 1 },
			]);

			await session.ask("Will compaction fail?");

			const compSpan = recorder
				.getSpans("compaction")
				.reverse()
				.find((span) => span.attributes["error.type"] === "compaction_failed");
			expect(compSpan).toBeDefined();
			expect(typeof compSpan?.status.message).toBe("string");
			expect((compSpan?.status.message ?? "").length).toBeGreaterThan(0);
			expect(compSpan?.ended).toBe(true);
			expect(compSpan?.status.code).toBe(SpanStatusCode.ERROR);
			expect(compSpan?.attributes["error.type"]).toBe("compaction_failed");
		});

		test("unexpected ask failures record structured details on the ask span", async () => {
			const session = new Session(createMockRepo(), createMockConfig());

			await expect(
				session.ask("Explode", {
					onProgress: () => {
						throw new Error("progress exploded");
					},
				}),
			).rejects.toThrow("progress exploded");

			const askSpan = recorder.getSpan("ask");
			expectSpanErrorDetails(askSpan, {
				errorType: "unexpected_error",
				message: "progress exploded",
			});
		});
	});
});
