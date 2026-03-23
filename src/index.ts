import { getModel, type KnownProvider, type Message, stream, streamSimple } from "@mariozechner/pi-ai";
import { type CompactionSettings, MODEL_NAME, MODEL_PROVIDER, type ThinkingConfig } from "./config";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import { consoleLogger, type Logger, nullLogger } from "./logger";
import { buildDefaultSystemPrompt } from "./prompt";
import { SandboxClient, type SandboxClientConfig } from "./sandbox/client";
import {
	type AskOptions,
	type AskResult,
	type InvalidLink,
	type OnProgress,
	type ProgressEvent,
	Session,
	type ToolCallRecord,
} from "./session";
import { executeTool, tools } from "./tools";

// Re-export all public types and loggers
export type {
	AskOptions,
	AskResult,
	CompactionSettings,
	ConnectOptions,
	Forge,
	ForgeName,
	InvalidLink,
	KnownProvider,
	Logger,
	Message,
	OnProgress,
	ProgressEvent,
	Repo,
	SandboxClientConfig,
	Session,
	ThinkingConfig,
	ToolCallRecord,
};
export { buildDefaultSystemPrompt, consoleLogger, nullLogger };

/** Base configuration fields */
interface ForgeConfigBase {
	/** System prompt that defines the assistant's behavior (has a sensible default) */
	systemPrompt?: string;
	/** Maximum number of tool-use iterations before stopping (default: 20) */
	maxIterations?: number;
	/**
	 * Optional sandbox configuration.
	 * If provided, repository cloning and tool execution happen in an isolated sandbox.
	 * If omitted, operations run locally.
	 */
	sandbox?: SandboxClientConfig;
	/**
	 * Optional context compaction settings.
	 * When context grows too large, older messages are summarized to stay within limits.
	 * If omitted, uses sensible defaults (enabled with 200K context window).
	 */
	compaction?: Partial<CompactionSettings>;
	/**
	 * Optional reasoning/thinking level.
	 * Controls the model's thinking effort across providers (Anthropic, OpenAI, Google, etc.).
	 * If omitted, thinking is off (default).
	 */
	thinking?: ThinkingConfig;
}

/**
 * Configuration for the ask-forge library.
 *
 * Provider and model must either both be specified or both omitted.
 * If omitted, defaults to openrouter with claude-sonnet-4.6.
 */
export type ForgeConfig = ForgeConfigBase &
	(
		| {
				/** Model provider (e.g., "openrouter", "anthropic", "google") */
				provider: KnownProvider;
				/** Model name (must be compatible with the provider) */
				model: string;
		  }
		| {
				provider?: undefined;
				model?: undefined;
		  }
	);

/**
 * Client for connecting to repositories and creating sessions.
 *
 * The client holds configuration (model, prompts, sandbox settings) and can create
 * multiple sessions to different repositories. When using sandbox mode, the sandbox
 * client is reused across all sessions for efficiency.
 *
 * @example
 * ```ts
 * const client = new AskForgeClient({
 *   provider: "openrouter",
 *   model: "anthropic/claude-sonnet-4.6",
 *   systemPrompt: "You are a code analysis assistant.",
 *   maxIterations: 20,
 * });
 *
 * const session1 = await client.connect("https://github.com/owner/repo1");
 * const session2 = await client.connect("https://github.com/owner/repo2");
 * ```
 */
/** Resolved configuration with all defaults applied */
interface ResolvedConfig {
	provider: KnownProvider;
	model: string;
	/** Custom system prompt override. When undefined, a default prompt with repo links is built at connect() time. */
	systemPrompt: string | undefined;
	maxIterations: number;
	sandbox?: SandboxClientConfig;
	compaction?: Partial<CompactionSettings>;
	thinking?: ThinkingConfig;
}

export class AskForgeClient {
	/** The configuration used by this client (with defaults applied) */
	readonly config: ResolvedConfig;

	readonly #logger: Logger;
	readonly #sandboxClient?: SandboxClient;

	/**
	 * Create a new AskForgeClient.
	 *
	 * @param config - Library configuration (defaults to openrouter with claude-sonnet-4.6)
	 * @param logger - Logger instance (defaults to consoleLogger)
	 */
	constructor(config: ForgeConfig = {}, logger: Logger = consoleLogger) {
		this.config = {
			provider: config.provider ?? MODEL_PROVIDER,
			model: config.model ?? MODEL_NAME,
			systemPrompt: config.systemPrompt,
			maxIterations: config.maxIterations ?? 20,
			sandbox: config.sandbox,
			compaction: config.compaction,
			thinking: config.thinking,
		};
		this.#logger = logger;

		if (this.config.sandbox) {
			this.#sandboxClient = new SandboxClient(this.config.sandbox, this.#logger);
		}
	}

	/**
	 * Connect to a repository and create a session.
	 *
	 * @param repoUrl - The URL of the repository to connect to
	 * @param options - Git connection options (token, forge, commitish)
	 * @param onProgress - Optional callback for clone progress messages (useful for long clones)
	 * @returns A Session for asking questions about the repository
	 */
	async connect(
		repoUrl: string,
		options: ConnectOptions = {},
		onProgress?: (message: string) => void,
	): Promise<Session> {
		const { config } = this;

		// getModel has strict generics tying provider to model IDs - cast for flexibility
		const model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(config.provider, config.model);

		if (this.#sandboxClient) {
			// Sandbox mode: clone and execute tools in isolated container
			const cloneResult = await this.#sandboxClient.clone(repoUrl, options.commitish, onProgress);

			// Create a Repo-like object with sandbox metadata
			const repo: Repo = {
				url: repoUrl,
				localPath: cloneResult.worktree,
				forge: { name: "github", buildCloneUrl: (url) => url }, // Sandbox handles auth
				commitish: cloneResult.sha,
				cachePath: "", // Not applicable for sandbox
			};

			// Capture sandboxClient reference for the closure
			const sandboxClient = this.#sandboxClient;

			// Wrap sandbox executeTool to match the expected signature
			const sandboxExecuteTool = async (name: string, args: Record<string, unknown>, _cwd: string) => {
				return sandboxClient.executeTool(cloneResult.slug, cloneResult.sha, name, args);
			};

			const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoUrl, repo.commitish);

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

		// Local mode: clone and execute tools on local filesystem
		const repo = await connectRepo(repoUrl, options);

		const systemPrompt = config.systemPrompt ?? buildDefaultSystemPrompt(repoUrl, repo.commitish);

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
	 *
	 * @throws Error if sandbox mode is not enabled
	 */
	async resetSandbox(): Promise<void> {
		if (!this.#sandboxClient) {
			throw new Error("Sandbox mode is not enabled");
		}
		await this.#sandboxClient.reset();
	}
}
