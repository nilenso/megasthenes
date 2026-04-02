/**
 * Client for the sandbox worker service.
 *
 * The orchestrator uses this to delegate git cloning and tool execution
 * to the isolated container. Communicates over HTTP on the compose internal network.
 */

import { type Logger, nullLogger } from "../logger";

export interface SandboxClientConfig {
	/** Base URL of the sandbox worker. */
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
/** Interval between clone status polls. */
const CLONE_POLL_INTERVAL_MS = 2_000;

export class SandboxClient {
	private config: SandboxClientConfig;
	private logger: Logger;

	constructor(config: SandboxClientConfig, logger: Logger = nullLogger) {
		this.config = config;
		this.logger = logger;
	}

	private authHeaders(): Record<string, string> {
		if (!this.config.secret) return {};
		return { Authorization: `Bearer ${this.config.secret}` };
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
	async clone(url: string, commitish?: string, onProgress?: (message: string) => void): Promise<CloneResult> {
		const commit = commitish ?? "HEAD";
		this.logger.debug("sandbox:client", `POST /clone url=${url} commitish=${commit}`);
		const t0 = Date.now();

		// Step 1: Kick off clone
		const startRes = await fetch(`${this.config.baseUrl}/clone`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.authHeaders() },
			body: JSON.stringify({ url, commitish }),
			signal: AbortSignal.timeout(30_000), // Starting a clone should be fast
		});

		const startBody = (await startRes.json()) as {
			ok: boolean;
			status?: string;
			slug?: string;
			sha?: string;
			worktree?: string;
			error?: string;
		};

		if (!startBody.ok) {
			this.logger.error("sandbox:client", new Error(`POST /clone → ${startRes.status}: ${startBody.error}`));
			throw new Error(`Sandbox clone failed: ${startBody.error}`);
		}

		// Already ready (cached)
		if (startBody.status === "ready" && startBody.slug && startBody.sha && startBody.worktree) {
			const duration = Date.now() - t0;
			this.logger.debug(
				"sandbox:client",
				`POST /clone → ready (cached) (${duration}ms) slug=${startBody.slug} sha=${startBody.sha.slice(0, 12)}`,
			);
			onProgress?.("Repository ready");
			return { slug: startBody.slug, sha: startBody.sha, worktree: startBody.worktree };
		}

		const slug = startBody.slug;
		if (!slug) {
			throw new Error("Sandbox clone failed: no slug returned");
		}

		// Step 2: Poll until ready or failed
		this.logger.debug("sandbox:client", `clone started for ${url}, polling status...`);
		onProgress?.("Cloning repository…");

		const deadline = Date.now() + CLONE_POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await Bun.sleep(CLONE_POLL_INTERVAL_MS);

			const statusRes = await fetch(
				`${this.config.baseUrl}/clone/status/${slug}?commitish=${encodeURIComponent(commit)}`,
				{
					headers: { ...this.authHeaders() },
					signal: AbortSignal.timeout(10_000),
				},
			);

			if (statusRes.status === 404) {
				this.logger.warn("sandbox:client", `clone job not found for ${slug}, re-triggering clone for ${url}`);
				onProgress?.("Re-cloning repository…");

				const retryRes = await fetch(`${this.config.baseUrl}/clone`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...this.authHeaders() },
					body: JSON.stringify({ url, commitish }),
					signal: AbortSignal.timeout(30_000),
				});

				const retryBody = (await retryRes.json()) as {
					ok: boolean;
					status?: string;
					slug?: string;
					sha?: string;
					worktree?: string;
					error?: string;
				};

				if (!retryBody.ok) {
					throw new Error(`Sandbox clone failed on retry: ${retryBody.error}`);
				}

				// If the re-triggered clone is already cached/ready, return immediately
				if (retryBody.status === "ready" && retryBody.slug && retryBody.sha && retryBody.worktree) {
					const duration = Date.now() - t0;
					this.logger.debug(
						"sandbox:client",
						`clone ready on retry (${duration}ms) slug=${retryBody.slug} sha=${retryBody.sha.slice(0, 12)}`,
					);
					onProgress?.("Repository ready");
					return { slug: retryBody.slug, sha: retryBody.sha, worktree: retryBody.worktree };
				}

				// Otherwise continue polling for the re-triggered job
				continue;
			}

			const statusBody = (await statusRes.json()) as {
				ok: boolean;
				status?: string;
				slug?: string;
				sha?: string;
				worktree?: string;
				error?: string;
				elapsedMs?: number;
			};

			if (statusBody.status === "ready" && statusBody.sha && statusBody.worktree) {
				const duration = Date.now() - t0;
				this.logger.debug(
					"sandbox:client",
					`clone ready (${duration}ms) slug=${slug} sha=${statusBody.sha.slice(0, 12)}`,
				);
				onProgress?.("Repository ready");
				return { slug: statusBody.slug ?? slug, sha: statusBody.sha, worktree: statusBody.worktree };
			}

			if (statusBody.status === "failed") {
				const duration = Date.now() - t0;
				this.logger.error("sandbox:client", new Error(`clone failed after ${duration}ms: ${statusBody.error}`));
				throw new Error(`Sandbox clone failed: ${statusBody.error}`);
			}

			// Still cloning — log progress
			const elapsed = statusBody.elapsedMs ?? Date.now() - t0;
			const elapsedSec = Math.round(elapsed / 1000);
			this.logger.debug("sandbox:client", `clone in progress for ${url} (${elapsedSec}s elapsed)`);
			onProgress?.(`Cloning repository… ${elapsedSec}s`);
		}

		throw new Error(`Sandbox clone timed out after ${CLONE_POLL_TIMEOUT_MS / 1000}s for ${url}`);
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
