import { getModel, type KnownProvider, type Message, stream, streamSimple } from "@mariozechner/pi-ai";
import type { CompactionSettings, ThinkingConfig } from "./config";
import { classifyThrownError } from "./error-classification";
import { MegasthenesError } from "./errors";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import { consoleLogger, type Logger, nullLogger } from "./logger";
import { buildDefaultSystemPrompt } from "./prompt";
import { SandboxClient, type SandboxClientConfig } from "./sandbox/client";
import { type PublicSessionConfig, Session } from "./session";
import { executeTool, tools } from "./tools";
import {
	annotateRootAskSpan,
	endChildSpan,
	endChildSpanWithError,
	endRootAskSpanWithError,
	startChildSpan,
	startRootAskSpan,
} from "./tracing";
import type {
	AskOptions,
	AskStream,
	ErrorType,
	ModelConfig,
	RepoConfig,
	Step,
	StreamEvent,
	TokenUsage,
	TurnMetadata,
	TurnResult,
} from "./types";

// Re-export all public types and loggers
export type {
	AskOptions,
	AskStream,
	CompactionSettings,
	ErrorType,
	Forge,
	ForgeName,
	KnownProvider,
	Logger,
	Message,
	ModelConfig,
	PublicSessionConfig,
	Repo,
	RepoConfig,
	SandboxClientConfig,
	Session,
	Step,
	StreamEvent,
	ThinkingConfig,
	TokenUsage,
	TurnMetadata,
	TurnResult,
};
export { buildDefaultSystemPrompt, consoleLogger, MegasthenesError, nullLogger };

// =============================================================================
// ClientConfig — infrastructure only
// =============================================================================

/** Client configuration. Holds shared infrastructure, no behavioral config. */
export interface ClientConfig {
	/** Sandbox configuration. If omitted, runs locally. */
	sandbox?: SandboxClientConfig;
	/** Logger. If omitted, uses consoleLogger. */
	logger?: Logger;
}

// =============================================================================
// SessionConfig — behavioral config for a single session
// =============================================================================

/** Configuration for a single session. Required at connect() time. Immutable after creation. */
export interface SessionConfig {
	/** Repository to connect to. Required. */
	repo: RepoConfig;
	/** Model to use. Required. */
	model: ModelConfig;
	/** System prompt. If omitted, a default code-analysis prompt is built. */
	systemPrompt?: string;
	/** Max tool-use iterations per turn. Required. */
	maxIterations: number;
	/** Thinking/reasoning configuration. If omitted, thinking is off. */
	thinking?: ThinkingConfig;
	/** Context compaction settings. If omitted, compaction is off. */
	compaction?: CompactionSettings;
	/** Prior turns to seed the session with. Restores LLM context from previous conversation. */
	initialTurns?: TurnResult[];
	/** Last compaction summary from a prior session. Required for compaction continuity when restoring with initialTurns. */
	lastCompactionSummary?: string;
}

// =============================================================================
// Client
// =============================================================================

/**
 * Client for connecting to repositories and creating sessions.
 *
 * The client holds shared infrastructure (sandbox, logging). Behavioral
 * configuration (model, thinking, iterations) is set per-session at
 * connect() time.
 *
 * @example
 * ```ts
 * const client = new Client();
 * const session = await client.connect({
 *   repo: { url: "https://github.com/owner/repo" },
 *   model: { provider: "anthropic", id: "claude-sonnet-4-6" },
 *   maxIterations: 20,
 * });
 * try {
 *   for await (const ev of session.ask("...")) { ... }
 * } finally {
 *   await session.close();
 * }
 * ```
 *
 * **Always close the returned session.** `connect()` starts a root OTel span
 * that only ends in `Session.close()`; skipping close causes the entire trace
 * tree for that session to be dropped. See `Session.close()` for details.
 */
function classifyConnectError(error: unknown): ErrorType {
	if (error instanceof MegasthenesError) {
		return error.errorType;
	}
	const classified = classifyThrownError(error);
	return classified.errorType === "network_error" ? "network_error" : "internal_error";
}

export class Client {
	readonly #logger: Logger;
	readonly #sandboxClient?: SandboxClient;

	constructor(config: ClientConfig = {}) {
		this.#logger = config.logger ?? consoleLogger;

		if (config.sandbox) {
			this.#sandboxClient = new SandboxClient(config.sandbox, this.#logger);
		}
	}

	/**
	 * Connect to a repository and create a session.
	 *
	 * Starts a root OTel "ask" span that lives until `Session.close()` is called.
	 * The caller MUST invoke `session.close()` (typically in a `finally` block)
	 * or the root span never ends and the OTel SDK drops the whole trace on
	 * shutdown. See `Session.close()` for details.
	 *
	 * @param config - Session configuration (repo, model, iterations, etc.)
	 * @param onProgress - Optional callback for clone progress messages
	 * @returns A Session for asking questions about the repository
	 */
	async connect(config: SessionConfig, onProgress?: (message: string) => void): Promise<Session> {
		const { repo: repoConfig, model: modelConfig } = config;
		const requestedCommitish = repoConfig.commitish ?? "HEAD";
		const connectMode = this.#sandboxClient ? "sandbox" : "local";
		const traceRoot = startRootAskSpan({
			repoUrl: repoConfig.url,
			requestedCommitish,
			mode: connectMode,
		});
		const connectSpan = startChildSpan(traceRoot, "connect", {
			"megasthenes.repo.url": repoConfig.url,
			"megasthenes.repo.requested_commitish": requestedCommitish,
			"megasthenes.connect.mode": connectMode,
		});

		try {
			// getModel has strict generics tying provider to model IDs - cast for flexibility
			const model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(
				modelConfig.provider,
				modelConfig.id,
			);

			if (this.#sandboxClient) {
				const cloneResult = await this.#sandboxClient.clone(
					repoConfig.url,
					repoConfig.commitish,
					onProgress,
					connectSpan,
				);

				const repo: Repo = {
					url: repoConfig.url,
					localPath: cloneResult.worktree,
					forge: { name: "github", buildCloneUrl: (url) => url },
					commitish: cloneResult.sha,
					cachePath: "",
				};

				const sandboxClient = this.#sandboxClient;
				const sandboxExecuteTool = async (name: string, args: Record<string, unknown>, _cwd: string) => {
					return sandboxClient.executeTool(cloneResult.slug, cloneResult.sha, name, args);
				};

				const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoConfig.url, repo.commitish);
				const session = new Session(
					repo,
					{
						model,
						systemPrompt,
						tools,
						maxIterations: config.maxIterations,
						executeTool: sandboxExecuteTool,
						logger: this.#logger,
						stream,
						streamSimple,
						compaction: config.compaction,
						thinking: config.thinking,
						initialTurns: config.initialTurns,
						lastCompactionSummary: config.lastCompactionSummary,
					},
					traceRoot,
				);
				annotateRootAskSpan(traceRoot.rootSpan, {
					sessionId: session.id,
					commitish: repo.commitish,
					localPath: repo.localPath,
				});
				endChildSpan(connectSpan);
				return session;
			}

			// Local mode
			const connectOptions: ConnectOptions = {
				token: repoConfig.token,
				commitish: repoConfig.commitish,
				forge: repoConfig.forge,
			};
			const repo = await connectRepo(repoConfig.url, connectOptions, connectSpan);
			const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoConfig.url, repo.commitish);
			const session = new Session(
				repo,
				{
					model,
					systemPrompt,
					tools,
					maxIterations: config.maxIterations,
					executeTool,
					logger: this.#logger,
					stream,
					streamSimple,
					compaction: config.compaction,
					thinking: config.thinking,
					initialTurns: config.initialTurns,
					lastCompactionSummary: config.lastCompactionSummary,
				},
				traceRoot,
			);
			annotateRootAskSpan(traceRoot.rootSpan, {
				sessionId: session.id,
				commitish: repo.commitish,
				localPath: repo.localPath,
			});
			endChildSpan(connectSpan);
			return session;
		} catch (error) {
			const errorType = classifyConnectError(error);
			endChildSpanWithError(connectSpan, errorType, error);
			endRootAskSpanWithError(traceRoot.rootSpan, errorType, error);
			throw error;
		}
	}

	/**
	 * Reset the sandbox, deleting all cloned repositories.
	 * Only available when sandbox mode is enabled.
	 */
	async resetSandbox(): Promise<void> {
		if (!this.#sandboxClient) {
			throw new Error("Sandbox mode is not enabled");
		}
		await this.#sandboxClient.reset();
	}
}
