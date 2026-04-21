import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Span } from "@opentelemetry/api";
import { MegasthenesError } from "./errors";
import {
	type CachePhaseResult,
	ensureCachedRepo,
	ensureWorktree,
	removeWorktree,
	resolveCommitish,
	withCloneLock,
} from "./forge/git";
import { type Forge, type ForgeName, forges, inferForge, parseRepoPath } from "./forge/providers";
import { endChildSpan, withChildSpan } from "./tracing";

export type { Forge, ForgeName } from "./forge/providers";
export { inferForge } from "./forge/providers";

/** Options for connecting to a repository */
export interface ConnectOptions {
	/** Authentication token for private repositories */
	token?: string;
	/** Forge type override (auto-detected from URL if not specified) */
	forge?: ForgeName;
	/** Git commitish to checkout (branch, tag, SHA, or relative ref like HEAD~1) */
	commitish?: string;
}

/** Represents a connected repository */
export interface Repo {
	/** Original repository URL */
	url: string;
	/** Local filesystem path to the worktree */
	localPath: string;
	/** The forge this repository is hosted on */
	forge: Forge;
	/** The resolved commit SHA */
	commitish: string;
	/** Path to the bare git cache */
	cachePath: string;
}

/**
 * Outcome of `cleanupRepo`. On failure, `details` is an opaque bag the caller
 * can forward to a logger without inspecting — keeping callers free of
 * backend-specific knowledge (worktree paths, exit codes, stderr, etc.).
 */
export type CleanupResult = { ok: true } | { ok: false; details?: Record<string, unknown> };

/**
 * Release the forge-managed artifacts for a repo. Symmetric with `connectRepo`.
 *
 * Repeated cleanups of an already-released repo resolve as `{ ok: true }` so
 * idempotent calls don't masquerade as failures. Real failures return
 * `{ ok: false, details }` where `details` captures backend-specific context
 * (currently the worktree path, git exit code, and stderr) for observability.
 *
 * @param repo - The repository to release
 */
export async function cleanupRepo(repo: Repo): Promise<CleanupResult> {
	try {
		const result = await removeWorktree(repo.cachePath, repo.localPath);
		if (result.ok) return { ok: true };
		return { ok: false, details: { path: repo.localPath, exitCode: result.exitCode, stderr: result.stderr } };
	} catch (error) {
		return { ok: false, details: { path: repo.localPath, error } };
	}
}

function recordCachePhaseOutcome(span: Span | undefined, cachePath: string, result: CachePhaseResult): void {
	const base = {
		"megasthenes.repo.cache_path": cachePath,
		"megasthenes.repo.cache_exists": result.cacheExisted,
	};
	if (result.operation === "fetch") {
		span?.addEvent("repo.fetch.finished");
		endChildSpan(span, {
			...base,
			"megasthenes.repo.commitish_present_locally": false,
			"megasthenes.git.operation": "fetch",
		});
		return;
	}
	if (result.operation === "reuse_cache") {
		span?.addEvent("repo.cache.hit");
		endChildSpan(span, {
			...base,
			"megasthenes.repo.commitish_present_locally": true,
			"megasthenes.git.operation": "reuse_cache",
		});
		return;
	}
	span?.addEvent("repo.clone.finished");
	endChildSpan(span, {
		...base,
		"megasthenes.git.operation": "clone",
	});
}

/**
 * Connect to a git repository, cloning if necessary and creating a worktree.
 *
 * Repositories are cached as bare clones in ~/.megasthenes/repos/{user}/{repo}/repo.
 * Each unique commitish gets its own worktree in ~/.megasthenes/repos/{user}/{repo}/trees/{sha}.
 *
 * @param repoUrl - The repository URL (https://github.com/user/repo)
 * @param options - Connection options (token, forge, commitish)
 * @returns A Repo object with paths and metadata
 * @throws Error if the forge cannot be inferred or git operations fail
 */
export async function connectRepo(repoUrl: string, options: ConnectOptions = {}, parentSpan?: Span): Promise<Repo> {
	const forgeName = options.forge ?? inferForge(repoUrl);
	if (!forgeName) {
		throw new MegasthenesError(
			"invalid_config",
			`Cannot infer forge from URL: ${repoUrl}. Please specify 'forge' option.`,
			{ retryability: "no" },
		);
	}

	const forge = forges[forgeName];
	const { username, reponame } = parseRepoPath(repoUrl);
	const basePath = join(homedir(), ".megasthenes", "repos", username, reponame);
	const cachePath = join(basePath, "repo");
	const commitish = options.commitish ?? "HEAD";

	await withChildSpan(parentSpan, "repo.clone_or_fetch", "clone_failed", async (span) => {
		const result = await withCloneLock(cachePath, () =>
			ensureCachedRepo(cachePath, commitish, () => forge.buildCloneUrl(repoUrl, options.token)),
		);
		recordCachePhaseOutcome(span, cachePath, result);
	});

	const sha = await withChildSpan(parentSpan, "repo.resolve_commitish", "invalid_commitish", async (span) => {
		const resolved = await resolveCommitish(cachePath, commitish);
		endChildSpan(span, {
			"megasthenes.repo.requested_commitish": commitish,
			"megasthenes.repo.commitish": resolved,
		});
		return resolved;
	});

	const worktreePath = resolve(basePath, "trees", sha.slice(0, 12));
	await withChildSpan(parentSpan, "repo.create_worktree", "clone_failed", async (span) => {
		const { reused } = await ensureWorktree(cachePath, sha, worktreePath);
		endChildSpan(span, {
			"megasthenes.repo.worktree_path": worktreePath,
			"megasthenes.connect.worktree_reused": reused,
		});
	});

	return {
		url: repoUrl,
		localPath: worktreePath,
		forge,
		commitish: sha,
		cachePath: resolve(cachePath),
	};
}
