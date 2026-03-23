/**
 * OpenTelemetry instrumentation for ask-forge.
 *
 * This module emits OTel spans following the GenAI semantic conventions.
 * The library only depends on @opentelemetry/api — if the consumer hasn't
 * installed an OTel SDK, all calls are automatic no-ops with zero overhead.
 *
 * Trace tree structure:
 *   ask (root span)
 *   ├── compaction (child span, always emitted)
 *   ├── gen_ai.chat (child span, per LLM iteration)
 *   ├── gen_ai.execute_tool (child span, per tool call)
 *   ├── gen_ai.chat
 *   └── gen_ai.chat (final response)
 *
 * Consumer setup (application side):
 *   import { NodeSDK } from "@opentelemetry/sdk-node";
 *   import { LangfuseSpanProcessor } from "@langfuse/otel";
 *   const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
 *   sdk.start();
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("ask-forge");

// =============================================================================
// Attribute keys (GenAI semantic conventions + ask-forge extensions)
// =============================================================================

const ATTR = {
	// GenAI standard
	OPERATION_NAME: "gen_ai.operation.name",
	REQUEST_MODEL: "gen_ai.request.model",
	PROVIDER_NAME: "gen_ai.provider.name",
	USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
	USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
	USAGE_CACHE_READ: "gen_ai.usage.cache_read.input_tokens",
	USAGE_CACHE_CREATION: "gen_ai.usage.cache_creation.input_tokens",
	TOOL_NAME: "gen_ai.tool.name",
	TOOL_CALL_ID: "gen_ai.tool.call.id",

	STOP_REASON: "gen_ai.response.finish_reason",

	// ask-forge extensions
	SESSION_ID: "ask_forge.session.id",
	REPO_URL: "ask_forge.repo.url",
	REPO_COMMITISH: "ask_forge.repo.commitish",
	ITERATION: "ask_forge.iteration",
	TOTAL_ITERATIONS: "ask_forge.total_iterations",
	TOTAL_TOOL_CALLS: "ask_forge.total_tool_calls",
	COMPACTION_WAS_COMPACTED: "ask_forge.compaction.was_compacted",
	COMPACTION_TOKENS_BEFORE: "ask_forge.compaction.tokens_before",
	COMPACTION_TOKENS_AFTER: "ask_forge.compaction.tokens_after",
	RESPONSE_TOTAL_LINKS: "ask_forge.response.total_links",
	RESPONSE_INVALID_LINKS: "ask_forge.response.invalid_links",
	ERROR_TYPE: "error.type",
} as const;

// OTel event names (GenAI semantic conventions)
const EVENT = {
	SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
	INPUT_MESSAGES: "gen_ai.input.messages",
	OUTPUT_MESSAGES: "gen_ai.output.messages",
	TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
	TOOL_CALL_RESULT: "gen_ai.tool.call.result",
} as const;

// =============================================================================
// Span helpers — thin wrappers that return OTel Span objects
// =============================================================================

/** Start the root span for an ask() call. */
export function startAskSpan(params: {
	question: string;
	sessionId: string;
	repoUrl: string;
	commitish: string;
	model: string;
	systemPrompt?: string;
}): Span {
	const span = tracer.startSpan("ask", {
		attributes: {
			[ATTR.OPERATION_NAME]: "chat",
			[ATTR.REQUEST_MODEL]: params.model,
			[ATTR.SESSION_ID]: params.sessionId,
			[ATTR.REPO_URL]: params.repoUrl,
			[ATTR.REPO_COMMITISH]: params.commitish,
		},
	});
	if (params.systemPrompt) {
		span.addEvent(EVENT.SYSTEM_INSTRUCTIONS, {
			content: params.systemPrompt,
		});
	}
	span.addEvent(EVENT.INPUT_MESSAGES, {
		content: params.question,
	});
	return span;
}

/** End the root ask span with final result metadata. */
export function endAskSpan(
	span: Span,
	result: {
		toolCallCount: number;
		totalIterations: number;
		totalLinks: number;
		invalidLinks: number;
		usage: { inputTokens: number; outputTokens: number };
	},
): void {
	span.setAttributes({
		[ATTR.RESPONSE_TOTAL_LINKS]: result.totalLinks,
		[ATTR.RESPONSE_INVALID_LINKS]: result.invalidLinks,
		[ATTR.USAGE_INPUT_TOKENS]: result.usage.inputTokens,
		[ATTR.USAGE_OUTPUT_TOKENS]: result.usage.outputTokens,
		[ATTR.TOTAL_ITERATIONS]: result.totalIterations,
		[ATTR.TOTAL_TOOL_CALLS]: result.toolCallCount,
	});
	span.setStatus({ code: SpanStatusCode.OK });
	span.end();
}

/** End the root ask span with an error. */
export function endAskSpanWithError(span: Span, errorType: string, error?: Error): void {
	span.setAttributes({ [ATTR.ERROR_TYPE]: errorType });
	span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
	if (error) {
		span.recordException(error);
	}
	span.end();
}

/** Start a compaction child span. */
export function startCompactionSpan(parentSpan: Span): Span {
	const ctx = trace.setSpan(context.active(), parentSpan);
	return tracer.startSpan("compaction", {}, ctx);
}

/** End the compaction span. */
export function endCompactionSpan(
	span: Span,
	result: { wasCompacted: boolean; tokensBefore?: number; tokensAfter?: number },
): void {
	span.setAttributes({
		[ATTR.COMPACTION_WAS_COMPACTED]: result.wasCompacted,
		...(result.tokensBefore !== undefined ? { [ATTR.COMPACTION_TOKENS_BEFORE]: result.tokensBefore } : {}),
		...(result.tokensAfter !== undefined ? { [ATTR.COMPACTION_TOKENS_AFTER]: result.tokensAfter } : {}),
	});
	span.setStatus({ code: SpanStatusCode.OK });
	span.end();
}

/** End the compaction span with an error. */
export function endCompactionSpanWithError(span: Span, error: unknown): void {
	span.setStatus({ code: SpanStatusCode.ERROR, message: "compaction failed" });
	if (error instanceof Error) {
		span.recordException(error);
	}
	span.end();
}

/** Start a generation child span for an LLM iteration. */
export function startGenerationSpan(
	parentSpan: Span,
	params: { iteration: number; model: string; provider: string; messages: unknown[] },
): Span {
	const ctx = trace.setSpan(context.active(), parentSpan);
	const span = tracer.startSpan(
		"gen_ai.chat",
		{
			attributes: {
				[ATTR.OPERATION_NAME]: "chat",
				[ATTR.REQUEST_MODEL]: params.model,
				[ATTR.PROVIDER_NAME]: params.provider,
				[ATTR.ITERATION]: params.iteration,
			},
		},
		ctx,
	);
	span.addEvent(EVENT.INPUT_MESSAGES, {
		content: JSON.stringify(params.messages),
	});
	return span;
}

/** End a generation span with success. */
export function endGenerationSpan(
	span: Span,
	result: {
		output: unknown;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		stopReason?: string;
	},
): void {
	span.setAttributes({
		[ATTR.USAGE_INPUT_TOKENS]: result.inputTokens,
		[ATTR.USAGE_OUTPUT_TOKENS]: result.outputTokens,
		[ATTR.USAGE_CACHE_READ]: result.cacheReadTokens,
		[ATTR.USAGE_CACHE_CREATION]: result.cacheCreationTokens,
		...(result.stopReason ? { [ATTR.STOP_REASON]: result.stopReason } : {}),
	});
	span.addEvent(EVENT.OUTPUT_MESSAGES, {
		content: JSON.stringify(result.output),
	});
	span.setStatus({ code: SpanStatusCode.OK });
	span.end();
}

/** End a generation span with an error. */
export function endGenerationSpanWithError(span: Span, error: unknown): void {
	span.setStatus({ code: SpanStatusCode.ERROR, message: "generation failed" });
	if (error instanceof Error) {
		span.recordException(error);
	} else if (typeof error === "string") {
		span.recordException(new Error(error));
	}
	span.end();
}

/** Start a tool execution child span. */
export function startToolSpan(
	parentSpan: Span,
	params: { toolName: string; toolCallId: string; args: Record<string, unknown> },
): Span {
	const ctx = trace.setSpan(context.active(), parentSpan);
	const span = tracer.startSpan(
		"gen_ai.execute_tool",
		{
			attributes: {
				[ATTR.OPERATION_NAME]: "execute_tool",
				[ATTR.TOOL_NAME]: params.toolName,
				[ATTR.TOOL_CALL_ID]: params.toolCallId,
			},
		},
		ctx,
	);
	span.addEvent(EVENT.TOOL_CALL_ARGUMENTS, {
		content: JSON.stringify(params.args),
	});
	return span;
}

/** End a tool span with its result. */
export function endToolSpan(span: Span, result: string): void {
	span.addEvent(EVENT.TOOL_CALL_RESULT, {
		content: result,
	});
	span.setStatus({ code: SpanStatusCode.OK });
	span.end();
}

/** End a tool span with an error. */
export function endToolSpanWithError(span: Span, error: unknown): void {
	span.setStatus({ code: SpanStatusCode.ERROR, message: "tool execution failed" });
	if (error instanceof Error) {
		span.recordException(error);
	}
	span.end();
}
