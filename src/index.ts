import { getModel, type KnownProvider, type Message, stream, streamSimple } from "@mariozechner/pi-ai";
import { type CompactionSettings, MODEL_NAME, MODEL_PROVIDER, type ThinkingConfig } from "./config";
import { type ConnectOptions, connectRepo, type Forge, type ForgeName, type Repo } from "./forge";
import { consoleLogger, type Logger, nullLogger } from "./logger";
import { buildDefaultSystemPrompt } from "./prompt";
import { SandboxClient, type SandboxClientConfig } from "./sandbox/client";
import { Session } from "./session";
import { executeTool, tools } from "./tools";
import type {
	AskStream,
	ModelConfig,
	NewAskOptions,
	Step,
	StreamEvent,
	TokenUsage,
	TurnMetadata,
	TurnResult,
} from "./types";

// Re-export all public types and loggers
export type {
	AskStream,
	CompactionSettings,
	ConnectOptions,
	Forge,
	ForgeName,
	KnownProvider,
	Logger,
	Message,
	ModelConfig,
	NewAskOptions as AskOptions,
	Repo,
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
 * Configuration for the megasthenes library.
 *
 * Provider and model must either both be specified or both omitted.
 * If omitted, defaults to anthropic with claude-sonnet-4.6.
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

export class Client {
	/** The configuration used by this client (with defaults applied) */
	readonly config: ResolvedConfig;

	readonly #logger: Logger;
	readonly #sandboxClient?: SandboxClient;

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

	async connect(
		repoUrl: string,
		options: ConnectOptions = {},
		onProgress?: (message: string) => void,
	): Promise<Session> {
		const { config } = this;

		// getModel has strict generics tying provider to model IDs - cast for flexibility
		const model = (getModel as (p: string, m: string) => ReturnType<typeof getModel>)(config.provider, config.model);

		if (this.#sandboxClient) {
			const cloneResult = await this.#sandboxClient.clone(repoUrl, options.commitish, onProgress);

			const repo: Repo = {
				url: repoUrl,
				localPath: cloneResult.worktree,
				forge: { name: "github", buildCloneUrl: (url) => url },
				commitish: cloneResult.sha,
				cachePath: "",
			};

			const sandboxClient = this.#sandboxClient;
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

	async resetSandbox(): Promise<void> {
		if (!this.#sandboxClient) {
			throw new Error("Sandbox mode is not enabled");
		}
		await this.#sandboxClient.reset();
	}
}
