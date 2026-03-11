import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	stream,
	type Tool,
} from "@mariozechner/pi-ai";
import { type CompactionSettings, maybeCompact } from "./compaction";
import { cleanupWorktree, type Repo } from "./forge";
import { consoleLogger, type Logger } from "./logger";
import { type ParsedLink, validateLinks } from "./response-validation";
import { processStream } from "./stream-processor";

// =============================================================================
// Types
// =============================================================================

/** Record of a tool call made during a session */
export interface ToolCallRecord {
	/** Name of the tool that was called */
	name: string;
	/** Arguments passed to the tool */
	arguments: Record<string, unknown>;
}

/** Result returned from Session.ask() */
export interface AskResult {
	/** The original question/prompt */
	prompt: string;
	/** List of tool calls made while answering */
	toolCalls: ToolCallRecord[];
	/** The final response text (or error message) */
	response: string;
	/** Token usage statistics */
	usage: Usage;
	/** Total time taken for inference in milliseconds */
	inferenceTimeMs: number;
	/** Total number of repo-pointing links found in the response */
	totalLinks: number;
	/** Links in the response whose repo-relative paths could not be found on disk */
	invalidLinks: InvalidLink[];
}

/** A link in the response that points to a non-existent file path */
export interface InvalidLink {
	/** The URL from the markdown link */
	url: string;
	/** The repo-relative path extracted from the URL */
	repoPath: string;
}

/** Token usage statistics for an ask operation */
export interface Usage {
	/** Number of input tokens */
	inputTokens: number;
	/** Number of output tokens */
	outputTokens: number;
	/** Total tokens (input + output) */
	totalTokens: number;
	/** Tokens read from cache */
	cacheReadTokens: number;
	/** Tokens written to cache */
	cacheWriteTokens: number;
}

/**
 * Progress events emitted during Session.ask() via the onProgress callback.
 *
 * Event sequence:
 * 0. "compaction" - Context compacted (if needed, before LLM call)
 * 1. "thinking" - Emitted at the start of each iteration
 * 2. "thinking_delta" - Model's thinking/reasoning (streaming)
 * 3. "text_delta" - Response text (streaming)
 * 4. "tool_start" - Tool call initiated
 * 5. "tool_delta" - Tool call arguments (streaming)
 * 6. "tool_end" - Tool call complete with final arguments
 * 7. "responding" - Final response ready (no more tool calls)
 */
export type ProgressEvent =
	| {
			type: "compaction";
			summary: string;
			firstKeptOrdinal: number;
			tokensBefore: number;
			tokensAfter: number;
			readFiles: string[];
			modifiedFiles: string[];
	  }
	| { type: "thinking" }
	| { type: "thinking_delta"; delta: string }
	| { type: "text_delta"; delta: string }
	| { type: "tool_start"; name: string; arguments: Record<string, unknown> }
	| { type: "tool_delta"; name: string; delta: string }
	| { type: "tool_end"; name: string; arguments: Record<string, unknown> }
	| { type: "responding" };

/** Callback function for receiving progress events during ask() */
export type OnProgress = (event: ProgressEvent) => void;

/** Options for Session.ask() */
export interface AskOptions {
	/** Callback for real-time progress events */
	onProgress?: OnProgress;
}

export type { Message };

// =============================================================================
// Helper Functions
// =============================================================================

function createEmptyUsage(): Usage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
}

function accumulateUsage(accumulated: Usage, response: AssistantMessage): void {
	if (response.usage) {
		accumulated.inputTokens += response.usage.input ?? 0;
		accumulated.outputTokens += response.usage.output ?? 0;
		accumulated.totalTokens += response.usage.totalTokens ?? 0;
		accumulated.cacheReadTokens += response.usage.cacheRead ?? 0;
		accumulated.cacheWriteTokens += response.usage.cacheWrite ?? 0;
	}
}

/** Context for building results throughout an ask operation */
interface AskContext {
	question: string;
	toolCalls: ToolCallRecord[];
	usage: Usage;
	startTime: number;
}

function buildResult(
	ctx: AskContext,
	response: string,
	linkStats: { totalLinks: number; invalidLinks: InvalidLink[] } = { totalLinks: 0, invalidLinks: [] },
): AskResult {
	return {
		prompt: ctx.question,
		toolCalls: ctx.toolCalls,
		response,
		usage: ctx.usage,
		inferenceTimeMs: Date.now() - ctx.startTime,
		totalLinks: linkStats.totalLinks,
		invalidLinks: linkStats.invalidLinks,
	};
}

// =============================================================================
// Session Class
// =============================================================================

/**
 * Configuration for creating a Session.
 * All dependencies are injectable for testing.
 */
export interface SessionConfig {
	/** The AI model to use for inference */
	model: Model<Api>;
	/** System prompt that defines the assistant's behavior */
	systemPrompt: string;
	/** Available tools the model can call */
	tools: Tool[];
	/** Maximum number of tool-use iterations before giving up */
	maxIterations: number;
	/** Function to execute tool calls */
	executeTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<string>;
	/** Logger for debug output (defaults to consoleLogger) */
	logger?: Logger;
	/** Stream function for AI inference (defaults to pi-ai's stream) */
	stream?: typeof stream;
	/** Context compaction settings (defaults to sensible values) */
	compaction?: Partial<CompactionSettings>;
}

/**
 * A Session manages a conversation with an AI model about a code repository.
 *
 * Sessions provide:
 * - Multi-turn conversations with message history
 * - Tool execution (file reading, code search, etc.)
 * - Progress callbacks for streaming UI updates
 * - Automatic cleanup of git worktrees on close
 *
 * @example
 * ```ts
 * const session = await connect(repoUrl);
 * const result = await session.ask("What does this repo do?");
 * console.log(result.response);
 * session.close();
 * ```
 */
export class Session {
	/** Unique identifier for this session */
	readonly id: string;
	/** The repository this session is connected to */
	readonly repo: Repo;

	#config: SessionConfig;
	#logger: Logger;
	#stream: typeof stream;
	#context: Context;
	#pending: Promise<AskResult> | null = null;
	#closed = false;
	#compactionSummary: string | undefined = undefined;

	constructor(repo: Repo, config: SessionConfig) {
		this.id = randomUUID();
		this.repo = repo;
		this.#config = config;
		this.#logger = config.logger ?? consoleLogger;
		this.#stream = config.stream ?? stream;
		this.#context = {
			systemPrompt: config.systemPrompt,
			messages: [],
			tools: config.tools,
		};
	}

	/**
	 * Ask a question about the repository.
	 *
	 * The model will use available tools to explore the codebase and formulate an answer.
	 * Concurrent calls are serialized (queued) to maintain conversation coherence.
	 *
	 * @param question - The question to ask
	 * @param options - Optional settings including progress callback
	 * @returns Result containing the response, tool calls made, and usage statistics
	 * @throws Error if the session has been closed
	 */
	async ask(question: string, options?: AskOptions): Promise<AskResult> {
		if (this.#closed) {
			throw new Error(`Session ${this.id} is closed`);
		}

		// Serialize concurrent calls
		if (this.#pending) {
			await this.#pending;
		}

		this.#pending = this.#doAsk(question, options?.onProgress);
		const result = await this.#pending;
		this.#pending = null;
		return result;
	}

	/**
	 * Get all messages in the conversation history.
	 * Includes user messages, assistant responses, and tool results.
	 */
	getMessages(): Message[] {
		return this.#context.messages;
	}

	/**
	 * Replace the entire conversation history.
	 * Useful for restoring a previous session state.
	 *
	 * @param messages - The new message history
	 */
	replaceMessages(messages: Message[]): void {
		this.#context.messages = messages;
	}

	/**
	 * Close the session and clean up resources.
	 *
	 * This removes the git worktree associated with the session.
	 * The session cannot be used after closing.
	 * Safe to call multiple times.
	 */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;

		// Clean up worktree, log if it fails
		const success = await cleanupWorktree(this.repo);
		if (!success) {
			this.#logger.error("Failed to cleanup worktree", { path: this.repo.localPath });
		}
	}

	async #doAsk(question: string, onProgress?: OnProgress): Promise<AskResult> {
		const ctx: AskContext = {
			question,
			toolCalls: [],
			usage: createEmptyUsage(),
			startTime: Date.now(),
		};

		// Check for compaction before adding the new question
		// Include the new question in the token estimate since it will be added to context
		const newQuestionMessage: Message = { role: "user", content: question, timestamp: Date.now() };
		const messagesWithQuestion = [...this.#context.messages, newQuestionMessage];

		try {
			const compactionResult = await maybeCompact(this.#config.model, messagesWithQuestion, this.#compactionSummary);

			if (compactionResult.wasCompacted) {
				// Replace session messages with compacted version (includes the new question)
				this.#context.messages = compactionResult.messages;
				this.#compactionSummary = compactionResult.summary;

				console.log(
					`[compaction] Context compacted: ${compactionResult.tokensBefore} -> ${compactionResult.tokensAfter} tokens`,
				);

				// Notify via progress callback
				onProgress?.({
					type: "compaction",
					summary: compactionResult.summary ?? "",
					firstKeptOrdinal: compactionResult.firstKeptOrdinal,
					tokensBefore: compactionResult.tokensBefore,
					tokensAfter: compactionResult.tokensAfter,
					readFiles: compactionResult.readFiles,
					modifiedFiles: compactionResult.modifiedFiles,
				});
			} else {
				// No compaction needed, just add the question
				this.#context.messages.push(newQuestionMessage);
			}
		} catch (compactionError) {
			// Compaction failed - log error but continue (just add the question)
			this.#logger.error("[compaction] Error during compaction:", compactionError);
			this.#context.messages.push(newQuestionMessage);
		}

		for (let iteration = 0; iteration < this.#config.maxIterations; iteration++) {
			onProgress?.({ type: "thinking" });

			const iterationResult = await this.#processIteration(ctx, iteration, onProgress);

			if (iterationResult.done) {
				return iterationResult.result;
			}
		}

		return buildResult(ctx, "[ERROR: Max iterations reached without a final answer.]");
	}

	async #processIteration(
		ctx: AskContext,
		iteration: number,
		onProgress?: OnProgress,
	): Promise<{ done: true; result: AskResult } | { done: false }> {
		const outcome = await processStream(this.#stream, this.#config.model, this.#context, onProgress);

		if (!outcome.ok) {
			this.#logger.error(`API call failed (iteration ${iteration + 1})`, {
				...(typeof outcome.errorDetails === "object" ? outcome.errorDetails : { error: outcome.errorDetails }),
				iteration: iteration + 1,
				timestamp: new Date().toISOString(),
			});
			return {
				done: true,
				result: buildResult(ctx, `[ERROR: ${outcome.error}]`),
			};
		}

		const response = outcome.response;
		accumulateUsage(ctx.usage, response);

		// Check for API error in response (fields may exist but not be in pi-ai's public types)
		const apiError = response as unknown as { stopReason?: string; errorMessage?: string };
		if (apiError.stopReason === "error" || apiError.errorMessage) {
			const errorMsg = apiError.errorMessage || "Unknown API error";
			this.#logger.error("API ERROR", {
				iteration: iteration + 1,
				stopReason: apiError.stopReason,
				errorMessage: errorMsg,
				timestamp: new Date().toISOString(),
				fullResponse: response,
			});
			return {
				done: true,
				result: buildResult(ctx, `[ERROR: ${errorMsg}]`),
			};
		}

		this.#context.messages.push(response);

		// Check if we have a final text response (no tool calls)
		const responseToolCalls = response.content.filter((b) => b.type === "toolCall");
		if (responseToolCalls.length === 0) {
			return {
				done: true,
				result: this.#buildTextResponse(ctx, response, onProgress),
			};
		}

		// Execute tool calls
		await this.#executeToolCalls(responseToolCalls, ctx.toolCalls);

		return { done: false };
	}

	#buildTextResponse(ctx: AskContext, response: AssistantMessage, onProgress?: OnProgress): AskResult {
		onProgress?.({ type: "responding" });

		const textBlocks = response.content.filter((b) => b.type === "text");
		const responseText = textBlocks.map((b) => (b as { type: "text"; text: string }).text).join("\n");

		if (!responseText.trim()) {
			this.#logger.error("WARNING: Empty response from API", { fullResponse: response });
			return buildResult(ctx, "[ERROR: Empty response from API - check API key and credits]");
		}

		// Validate links in the response
		const { totalRepoLinks, broken } = validateLinks(responseText, this.repo.localPath);
		const invalidLinks: InvalidLink[] = broken
			.filter((l): l is ParsedLink & { repoPath: string } => l.repoPath !== null)
			.map((l) => ({ url: l.url, repoPath: l.repoPath }));
		if (invalidLinks.length > 0) {
			this.#logger.error(`Found ${invalidLinks.length} invalid link(s) in response:`, invalidLinks);
		}

		this.#logger.log("RESPONSE", "");
		return buildResult(ctx, responseText, { totalLinks: totalRepoLinks, invalidLinks });
	}

	async #executeToolCalls(
		toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
		toolCallRecords: ToolCallRecord[],
	): Promise<void> {
		for (const call of toolCalls) {
			this.#logger.log(`TOOL: ${call.name}`, JSON.stringify(call.arguments, null, 2));
		}

		const toolExecStart = Date.now();
		const results = await Promise.all(
			toolCalls.map(async (call) => {
				const t0 = Date.now();
				const result = await this.#config.executeTool(call.name, call.arguments, this.repo.localPath);
				this.#logger.log(`TOOL_DONE: ${call.name}`, `${Date.now() - t0}ms`);
				return result;
			}),
		);
		this.#logger.log(`ALL_TOOLS_DONE: ${toolCalls.length} calls`, `${Date.now() - toolExecStart}ms`);

		// Push results back in request order to preserve conversation context
		toolCalls.forEach((call, j) => {
			toolCallRecords.push({
				name: call.name,
				arguments: call.arguments,
			});
			this.#context.messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: results[j] ?? "" }],
				isError: false,
				timestamp: Date.now(),
			});
		});
	}
}
