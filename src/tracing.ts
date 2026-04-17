/**
 * OpenTelemetry instrumentation for megasthenes.
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
import type { ErrorType } from "./types";

const tracer = trace.getTracer("megasthenes");

type TraceErrorStage = "ask" | "generation" | "compaction" | "tool_execution";

// =============================================================================
// Attribute keys (GenAI semantic conventions + megasthenes extensions)
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

	// megasthenes extensions
	SESSION_ID: "megasthenes.session.id",
	REPO_URL: "megasthenes.repo.url",
	REPO_COMMITISH: "megasthenes.repo.commitish",
	ITERATION: "megasthenes.iteration",
	TOTAL_ITERATIONS: "megasthenes.total_iterations",
	TOTAL_TOOL_CALLS: "megasthenes.total_tool_calls",
	COMPACTION_WAS_COMPACTED: "megasthenes.compaction.was_compacted",
	COMPACTION_TOKENS_BEFORE: "megasthenes.compaction.tokens_before",
	COMPACTION_TOKENS_AFTER: "megasthenes.compaction.tokens_after",
	ERROR_TYPE: "error.type",
	ERROR_NAME: "megasthenes.error.name",
	ERROR_MESSAGE: "megasthenes.error.message",
	ERROR_STAGE: "megasthenes.error.stage",
} as const;

// OTel event names (GenAI semantic conventions)
const EVENT = {
	SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
	INPUT_MESSAGES: "gen_ai.input.messages",
	OUTPUT_MESSAGES: "gen_ai.output.messages",
	TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
	TOOL_CALL_RESULT: "gen_ai.tool.call.result",
} as const;

function stringifyUnknownError(error: unknown): string {
	if (error === undefined) return "";
	if (error === null) return "null";
	if (
		typeof error === "string" ||
		typeof error === "number" ||
		typeof error === "boolean" ||
		typeof error === "bigint" ||
		typeof error === "symbol"
	) {
		return String(error);
	}

	try {
		const json = JSON.stringify(error);
		if (json && json !== "{}") {
			return json;
		}
	} catch {
		// Fall back to String(error) below when serialization fails.
	}

	return String(error);
}

function normalizeErrorDetails(
	error: unknown,
	fallbackMessage: string,
): { name: string; message: string; exception?: Error } {
	let rawName: string | undefined;
	let rawMessage: string | undefined;
	let exception: Error | undefined;

	if (error instanceof Error) {
		rawName = error.name;
		rawMessage = error.message;
		exception = error;
	} else if (error && typeof error === "object") {
		const errorLike = error as { name?: unknown; message?: unknown; errorMessage?: unknown };
		rawName = typeof errorLike.name === "string" ? errorLike.name : undefined;
		rawMessage =
			typeof errorLike.message === "string"
				? errorLike.message
				: typeof errorLike.errorMessage === "string"
					? errorLike.errorMessage
					: undefined;
	} else if (typeof error === "string") {
		rawMessage = error;
	}

	if (!rawMessage) {
		rawMessage = stringifyUnknownError(error);
	}

	const message = rawMessage.trim() || fallbackMessage;
	const name = rawName?.trim() || "Error";

	if (!exception && error !== undefined) {
		exception = new Error(message);
		exception.name = name;
	}

	return { name, message, exception };
}

function annotateErrorSpan(
	span: Span,
	params: {
		error: unknown;
		fallbackMessage: string;
		errorType?: ErrorType;
		stage?: TraceErrorStage;
	},
) {
	const details = normalizeErrorDetails(params.error, params.fallbackMessage);
	span.setAttributes({
		...(params.errorType ? { [ATTR.ERROR_TYPE]: params.errorType } : {}),
		...(params.stage ? { [ATTR.ERROR_STAGE]: params.stage } : {}),
		[ATTR.ERROR_NAME]: details.name,
		[ATTR.ERROR_MESSAGE]: details.message,
	});
	span.setStatus({ code: SpanStatusCode.ERROR, message: details.message });
	if (details.exception) {
		span.recordException(details.exception);
	}
	return details;
}

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
		usage: { inputTokens: number; outputTokens: number };
	},
): void {
	span.setAttributes({
		[ATTR.USAGE_INPUT_TOKENS]: result.usage.inputTokens,
		[ATTR.USAGE_OUTPUT_TOKENS]: result.usage.outputTokens,
		[ATTR.TOTAL_ITERATIONS]: result.totalIterations,
		[ATTR.TOTAL_TOOL_CALLS]: result.toolCallCount,
	});
	span.setStatus({ code: SpanStatusCode.OK });
	span.end();
}

/** End the root ask span with an error. */
export function endAskSpanWithError(span: Span, errorType: ErrorType, error?: unknown): void {
	// Keep trace error.type aligned with the public ErrorType union so SDK
	// consumers can query traces using the same values they see in TurnResult.
	annotateErrorSpan(span, {
		error,
		fallbackMessage: errorType,
		errorType,
		stage: "ask",
	});
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
	annotateErrorSpan(span, {
		error,
		fallbackMessage: "compaction failed",
		errorType: "internal_error",
		stage: "compaction",
	});
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
export function endGenerationSpanWithError(
	span: Span,
	params: { errorType: ErrorType; error?: unknown; fallbackMessage?: string },
): void {
	annotateErrorSpan(span, {
		error: params.error,
		fallbackMessage: params.fallbackMessage ?? params.errorType,
		errorType: params.errorType,
		stage: "generation",
	});
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
export function endToolSpanWithError(span: Span, error: unknown, result?: string): void {
	const details = annotateErrorSpan(span, {
		error,
		fallbackMessage: "tool execution failed",
		errorType: "internal_error",
		stage: "tool_execution",
	});
	span.addEvent(EVENT.TOOL_CALL_RESULT, {
		content: result ?? details.message,
	});
	span.end();
}
