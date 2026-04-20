/**
 * Client for the sandbox worker service.
 *
 * The orchestrator uses this to delegate git cloning and tool execution
 * to the isolated container. Communicates over HTTP on the compose internal network.
 */

import type { Attributes, Span } from "@opentelemetry/api";
import { classifyThrownError } from "../error-classification";
import { MegasthenesError } from "../errors";
import { type Logger, nullLogger } from "../logger";
import { endChildSpan, endChildSpanWithError, startChildSpan } from "../tracing";
import type { ErrorType, RepoConfig } from "../types";

/** Configuration for connecting to a sandbox worker. */
export interface SandboxClientConfig {
	/** Base URL of the sandbox worker (e.g. `"http://localhost:8080"`). */
	baseUrl: string;
	/** Request timeout in ms (used for tool execution and polling interval upper bound). */
	timeoutMs: number;
	/** Shared secret for authenticating with the sandbox worker. */
	secret?: string;
}

export interface CloneResult {
	slug: string;
	sha: string;
	worktree: string;
}

/** Maximum time to wait for a clone to complete (20 minutes). */
const CLONE_POLL_TIMEOUT_MS = 20 * 60 * 1000;
/** Initial interval between clone status polls. */
const CLONE_POLL_INITIAL_INTERVAL_MS = 1_000;
/** Maximum interval between clone status polls. */
const CLONE_POLL_MAX_INTERVAL_MS = 5_000;

/** Body returned by the sandbox worker when it has a protocol status to report. */
type CloneStatusBody =
	| { ok: true; status: "cloning"; slug: string; elapsedMs?: number }
	| { ok: true; status: "ready"; slug: string; sha: string; worktree: string }
	| { ok: false; status: "failed"; error: string; errorType?: ErrorType };

/** Envelope-level error body (e.g. 400 "url is required"), with no protocol status. */
interface CloneEnvelopeError {
	ok: false;
	error: string;
}

type CloneResponseBody = CloneStatusBody | CloneEnvelopeError;

function isStatusBody(body: CloneResponseBody): body is CloneStatusBody {
	return "status" in body;
}

function sandboxCloneError(body: { error?: string; errorType?: ErrorType }, fallbackMessage: string): MegasthenesError {
	const errorType: ErrorType = body.errorType ?? "clone_failed";
	const message = body.error ? `Sandbox clone failed: ${body.error}` : fallbackMessage;
	return new MegasthenesError(errorType, message, {
		retryability: errorType === "invalid_commitish" ? "no" : "yes",
	});
}

type TriggerOutcome = ({ kind: "ready" } & CloneResult) | { kind: "pending"; slug: string };

type PollOutcome =
	| ({ kind: "ready" } & CloneResult)
	| { kind: "failed"; error: string; errorType?: ErrorType }
	| { kind: "timed_out" };

type OnEvent = (name: string, attrs?: Attributes) => void;

function buildAuthHeaders(config: SandboxClientConfig): Record<string, string> {
	if (!config.secret) return {};
	return { Authorization: `Bearer ${config.secret}` };
}

async function triggerClone(
	config: SandboxClientConfig,
	repo: RepoConfig,
	fallbackPrefix: string,
): Promise<TriggerOutcome> {
	const res = await fetch(`${config.baseUrl}/clone`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...buildAuthHeaders(config) },
		body: JSON.stringify({ url: repo.url, commitish: repo.commitish }),
		signal: AbortSignal.timeout(30_000),
	});
	const body = (await res.json()) as CloneResponseBody;
	const fallback = `${fallbackPrefix} (HTTP ${res.status})`;

	if (!isStatusBody(body)) {
		throw sandboxCloneError(body, fallback);
	}

	switch (body.status) {
		case "ready":
			return { kind: "ready", slug: body.slug, sha: body.sha, worktree: body.worktree };
		case "cloning":
			return { kind: "pending", slug: body.slug };
		case "failed":
			throw sandboxCloneError(body, fallback);
	}
}

interface WaitArgs {
	slug: string;
	startTime: number;
	onProgress?: (message: string) => void;
	onEvent: OnEvent;
}

async function waitForClone(
	config: SandboxClientConfig,
	logger: Logger,
	repo: RepoConfig,
	args: WaitArgs,
): Promise<PollOutcome> {
	const deadline = Date.now() + CLONE_POLL_TIMEOUT_MS;
	let pollInterval = CLONE_POLL_INITIAL_INTERVAL_MS;
	let lastStatus: string | undefined;
	const commitishForStatus = repo.commitish ?? "HEAD";

	while (Date.now() < deadline) {
		await Bun.sleep(pollInterval);
		pollInterval = Math.min(pollInterval * 1.5, CLONE_POLL_MAX_INTERVAL_MS);

		const statusRes = await fetch(
			`${config.baseUrl}/clone/status/${args.slug}?commitish=${encodeURIComponent(commitishForStatus)}`,
			{ headers: buildAuthHeaders(config), signal: AbortSignal.timeout(10_000) },
		);

		if (statusRes.status === 404) {
			logger.warn("sandbox:client", `clone job not found for ${args.slug}, re-triggering clone for ${repo.url}`);
			args.onEvent("sandbox.clone.retry_after_404", { slug: args.slug });
			args.onProgress?.("Re-cloning repository…");
			const retry = await triggerClone(config, repo, "Sandbox clone failed on retry");
			if (retry.kind === "ready") {
				return retry;
			}
			continue;
		}

		const body = (await statusRes.json()) as CloneResponseBody;
		if (!isStatusBody(body)) {
			logger.warn("sandbox:client", `unexpected status response for ${args.slug}: ${body.error}`);
			continue;
		}

		if (body.status !== lastStatus) {
			args.onEvent("sandbox.clone.poll", {
				elapsed_ms: Date.now() - args.startTime,
				status: body.status,
				previous_status: lastStatus ?? "none",
			});
			lastStatus = body.status;
		}

		switch (body.status) {
			case "ready":
				return { kind: "ready", slug: body.slug, sha: body.sha, worktree: body.worktree };
			case "failed":
				return { kind: "failed", error: body.error, errorType: body.errorType };
			case "cloning": {
				const elapsed = body.elapsedMs ?? Date.now() - args.startTime;
				const elapsedSec = Math.round(elapsed / 1000);
				logger.debug("sandbox:client", `clone in progress for ${repo.url} (${elapsedSec}s elapsed)`);
				args.onProgress?.(`Cloning repository… ${elapsedSec}s`);
				break;
			}
		}
	}

	return { kind: "timed_out" };
}

function completeClone(
	cloneSpan: Span | undefined,
	onProgress: ((message: string) => void) | undefined,
	result: CloneResult,
): CloneResult {
	onProgress?.("Repository ready");
	endChildSpan(cloneSpan, {
		"megasthenes.sandbox.slug": result.slug,
		"megasthenes.repo.commitish": result.sha,
		"megasthenes.repo.local_path": result.worktree,
	});
	return { slug: result.slug, sha: result.sha, worktree: result.worktree };
}

export class SandboxClient {
	private config: SandboxClientConfig;
	private logger: Logger;

	constructor(config: SandboxClientConfig, logger: Logger = nullLogger) {
		this.config = config;
		this.logger = logger;
	}

	private authHeaders(): Record<string, string> {
		return buildAuthHeaders(this.config);
	}

	/** Check if the sandbox worker is reachable. */
	async health(): Promise<boolean> {
		try {
			const res = await fetch(`${this.config.baseUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			const body = (await res.json()) as { ok: boolean };
			return body.ok === true;
		} catch {
			return false;
		}
	}

	/**
	 * Wait for the sandbox worker to become healthy.
	 * Retries with backoff up to maxWaitMs.
	 */
	async waitForReady(maxWaitMs = 30_000): Promise<void> {
		const start = Date.now();
		let delay = 200;
		let attempt = 0;
		while (Date.now() - start < maxWaitMs) {
			attempt++;
			if (await this.health()) {
				this.logger.debug("sandbox:client", `healthy after ${attempt} attempt(s) (${Date.now() - start}ms)`);
				return;
			}
			this.logger.debug("sandbox:client", `waitForReady attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`);
			await Bun.sleep(delay);
			delay = Math.min(delay * 1.5, 3000);
		}
		throw new Error(`Sandbox worker not ready after ${maxWaitMs}ms`);
	}

	/**
	 * Clone a repository inside the sandbox.
	 * Kicks off an async clone and polls until ready (up to 20 minutes).
	 * @param onProgress - Optional callback invoked with status messages during polling
	 */
	async clone(
		url: string,
		commitish?: string,
		onProgress?: (message: string) => void,
		parentSpan?: Span,
	): Promise<CloneResult> {
		const commit = commitish ?? "HEAD";
		this.logger.debug("sandbox:client", `POST /clone url=${url} commitish=${commit}`);
		const t0 = Date.now();
		const cloneSpan = parentSpan ? startChildSpan(parentSpan, "sandbox.clone") : undefined;
		const onEvent: OnEvent = (name, attrs) => cloneSpan?.addEvent(name, attrs);
		const repo: RepoConfig = { url, commitish };

		try {
			onEvent("sandbox.clone.started", { url, commitish: commit });

			const trigger = await triggerClone(this.config, repo, "Sandbox clone failed");

			if (trigger.kind === "ready") {
				const duration = Date.now() - t0;
				this.logger.debug(
					"sandbox:client",
					`POST /clone → ready (cached) (${duration}ms) slug=${trigger.slug} sha=${trigger.sha.slice(0, 12)}`,
				);
				onEvent("sandbox.clone.cached_ready", { elapsed_ms: duration });
				return completeClone(cloneSpan, onProgress, trigger);
			}

			this.logger.debug("sandbox:client", `clone started for ${url}, polling status...`);
			onProgress?.("Cloning repository…");

			const outcome = await waitForClone(this.config, this.logger, repo, {
				slug: trigger.slug,
				startTime: t0,
				onProgress,
				onEvent,
			});

			if (outcome.kind === "ready") {
				const duration = Date.now() - t0;
				this.logger.debug(
					"sandbox:client",
					`clone ready (${duration}ms) slug=${outcome.slug} sha=${outcome.sha.slice(0, 12)}`,
				);
				onEvent("sandbox.clone.ready", { elapsed_ms: duration, slug: outcome.slug });
				return completeClone(cloneSpan, onProgress, outcome);
			}

			if (outcome.kind === "failed") {
				const duration = Date.now() - t0;
				onEvent("sandbox.clone.failed", { elapsed_ms: duration, slug: trigger.slug });
				this.logger.error("sandbox:client", new Error(`clone failed after ${duration}ms: ${outcome.error}`));
				throw sandboxCloneError(outcome, `Sandbox clone failed after ${duration}ms`);
			}

			onEvent("sandbox.clone.timed_out", { timeout_ms: CLONE_POLL_TIMEOUT_MS, slug: trigger.slug });
			throw new Error(`Sandbox clone timed out after ${CLONE_POLL_TIMEOUT_MS / 1000}s for ${url}`);
		} catch (error) {
			let errorType: ErrorType;
			if (error instanceof MegasthenesError) {
				errorType = error.errorType;
			} else {
				const classified = classifyThrownError(error);
				errorType = classified.errorType === "network_error" ? "network_error" : "clone_failed";
			}
			endChildSpanWithError(cloneSpan, errorType, error);
			throw error;
		}
	}

	/** Execute a tool inside the sandbox against a previously-cloned repo. */
	async executeTool(slug: string, sha: string, name: string, args: Record<string, unknown>): Promise<string> {
		this.logger.debug("sandbox:client", `POST /tool slug=${slug} sha=${sha.slice(0, 12)} name=${name}`);
		const t0 = Date.now();

		const res = await fetch(`${this.config.baseUrl}/tool`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.authHeaders() },
			body: JSON.stringify({ slug, sha, name, args }),
			signal: AbortSignal.timeout(this.config.timeoutMs),
		});

		const body = (await res.json()) as { ok: boolean; output?: string; error?: string };
		const duration = Date.now() - t0;

		if (!body.ok) {
			this.logger.warn("sandbox:client", `POST /tool ${name} → ${res.status} (${duration}ms): ${body.error}`);
			return `Error: ${body.error}`;
		}

		this.logger.debug("sandbox:client", `POST /tool ${name} → ${res.status} (${duration}ms)`);
		return body.output ?? "(no output)";
	}

	/** Delete all cloned repos in the sandbox. */
	async reset(): Promise<void> {
		this.logger.debug("sandbox:client", "POST /reset");
		const t0 = Date.now();

		const res = await fetch(`${this.config.baseUrl}/reset`, {
			method: "POST",
			headers: { ...this.authHeaders() },
			signal: AbortSignal.timeout(10_000),
		});

		const body = (await res.json()) as { ok: boolean; error?: string };
		const duration = Date.now() - t0;

		if (!body.ok) {
			this.logger.error("sandbox:client", new Error(`POST /reset → ${res.status} (${duration}ms): ${body.error}`));
			throw new Error(`Sandbox reset failed: ${body.error}`);
		}

		this.logger.debug("sandbox:client", `POST /reset → ${res.status} (${duration}ms)`);
	}
}
