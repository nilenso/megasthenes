import { getModel, type KnownProvider, type Message, stream, streamSimple } from "@mariozechner/pi-ai";
import type { CompactionSettings, ThinkingConfig } from "./config";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import { consoleLogger, type Logger, nullLogger } from "./logger";
import { buildDefaultSystemPrompt } from "./prompt";
import { SandboxClient, type SandboxClientConfig } from "./sandbox/client";
import { type PublicSessionConfig, Session } from "./session";
import { executeTool, tools } from "./tools";
import type {
	AskOptions,
	AskStream,
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
export { buildDefaultSystemPrompt, consoleLogger, nullLogger };

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
 * ```
 */
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
	 * @param config - Session configuration (repo, model, iterations, etc.)
	 * @param onProgress - Optional callback for clone progress messages
	 * @returns A Session for asking questions about the repository
	 */
	async connect(config: SessionConfig, onProgress?: (message: string) => void): Promise<Session> {
		const { repo: repoConfig, model: modelConfig } = config;

		// getModel has strict generics tying provider to model IDs - cast for flexibility
		const model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(
			modelConfig.provider,
			modelConfig.id,
		);

		if (this.#sandboxClient) {
			const cloneResult = await this.#sandboxClient.clone(repoConfig.url, repoConfig.commitish, onProgress);

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

			return new Session(repo, {
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
			});
		}

		// Local mode
		const connectOptions: ConnectOptions = {
			token: repoConfig.token,
			commitish: repoConfig.commitish,
			forge: repoConfig.forge,
		};
		const repo = await connectRepo(repoConfig.url, connectOptions);
		const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoConfig.url, repo.commitish);

		return new Session(repo, {
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
		});
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
