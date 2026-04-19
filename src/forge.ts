import { access, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Span } from "@opentelemetry/api";
import { MegasthenesError } from "./errors";
import { endChildSpan, withChildSpan } from "./tracing";

/**
 * Lock map to prevent race conditions when cloning the same repo in parallel.
 *
 * When multiple concurrent calls try to clone the same repository, this lock ensures
 * only one clone happens while others wait. Without this, concurrent clones to the
 * same path would corrupt the repository.
 *
 * Note: This lock is process-local. If multiple Node.js processes run simultaneously,
 * they will not share this lock and may still race. For multi-process scenarios,
 * consider using file-based locking or ensuring only one process clones at a time.
 */
const cloneLocks = new Map<string, Promise<void>>();

async function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	while (cloneLocks.has(key)) {
		await cloneLocks.get(key);
	}

	let resolveLock: (() => void) | undefined;
	const lockPromise = new Promise<void>((r) => {
		resolveLock = r;
	});
	cloneLocks.set(key, lockPromise);

	try {
		return await fn();
	} finally {
		cloneLocks.delete(key);
		resolveLock?.();
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function commitishExistsLocally(repoPath: string, commitish: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "cat-file", "-t", commitish], {
		cwd: repoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = (await new Response(proc.stdout).text()).trim();
	const exitCode = await proc.exited;
	return exitCode === 0 && (output === "commit" || output === "tag");
}

/** Supported git forge types */
export type ForgeName = "github" | "gitlab";

/** Interface for git forge implementations */
export interface Forge {
	/** The forge identifier */
	name: ForgeName;
	/** Build an authenticated clone URL */
	buildCloneUrl(repoUrl: string, token?: string): string;
}

const GitHubForge: Forge = {
	name: "github",
	buildCloneUrl(repoUrl: string, token?: string): string {
		if (!token) return repoUrl;
		const url = new URL(repoUrl);
		url.username = token;
		return url.toString();
	},
};

const GitLabForge: Forge = {
	name: "gitlab",
	buildCloneUrl(repoUrl: string, token?: string): string {
		if (!token) return repoUrl;
		const url = new URL(repoUrl);
		url.username = "oauth2";
		url.password = token;
		return url.toString();
	},
};

const forges: Record<ForgeName, Forge> = {
	github: GitHubForge,
	gitlab: GitLabForge,
};

function inferForge(repoUrl: string): ForgeName | null {
	const url = new URL(repoUrl);
	if (url.hostname === "github.com") return "github";
	if (url.hostname === "gitlab.com") return "gitlab";
	return null;
}

function parseRepoPath(repoUrl: string): { username: string; reponame: string } {
	const url = new URL(repoUrl);
	const parts = url.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.split("/");
	if (parts.length < 2 || !parts[0] || !parts[1]) {
		throw new MegasthenesError("invalid_config", `Invalid repo URL: ${repoUrl}`, { isRetryable: false });
	}
	return { username: parts[0], reponame: parts[1] };
}

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
 * Remove a git worktree associated with a repository.
 * Called automatically by Session.close().
 *
 * @param repo - The repository whose worktree should be removed
 * @returns true if cleanup succeeded, false otherwise
 */
export async function cleanupWorktree(repo: Repo): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "worktree", "remove", "--force", repo.localPath], {
			cwd: repo.cachePath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

type CacheOperation = "fetch" | "reuse_cache" | "clone";

interface CachePhaseResult {
	operation: CacheOperation;
	cacheExisted: boolean;
}

async function ensureCachedRepo(
	cachePath: string,
	commitish: string,
	buildCloneUrl: () => string,
): Promise<CachePhaseResult> {
	const headFile = join(cachePath, "HEAD");
	const cacheExists = await exists(headFile);

	if (cacheExists) {
		const hasCommitish = await commitishExistsLocally(cachePath, commitish);
		if (hasCommitish) {
			return { operation: "reuse_cache", cacheExisted: true };
		}
		const proc = Bun.spawn(["git", "fetch", "origin", "--tags"], {
			cwd: cachePath,
			stdout: "inherit",
			stderr: "inherit",
		});
		const fetchExit = await proc.exited;
		if (fetchExit !== 0) {
			throw new MegasthenesError("fetch_failed", `git fetch failed with exit code ${fetchExit}`, {
				isRetryable: true,
			});
		}
		return { operation: "fetch", cacheExisted: true };
	}

	// Clean up incomplete clone if directory exists but HEAD doesn't
	if (await exists(cachePath)) {
		await rm(cachePath, { recursive: true, force: true });
	}
	await mkdir(cachePath, { recursive: true });
	const proc = Bun.spawn(["git", "clone", "--bare", "--filter=blob:none", buildCloneUrl(), cachePath], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new MegasthenesError("clone_failed", `git clone failed with exit code ${exitCode}`, {
			isRetryable: true,
		});
	}
	return { operation: "clone", cacheExisted: false };
}

async function resolveCommitish(cachePath: string, commitish: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", commitish], {
		cwd: cachePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const resolved = (await new Response(proc.stdout).text()).trim();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new MegasthenesError("invalid_commitish", `Failed to resolve commitish: ${commitish}`, {
			isRetryable: false,
		});
	}
	return resolved;
}

async function ensureWorktree(cachePath: string, sha: string, worktreePath: string): Promise<{ reused: boolean }> {
	if (await exists(worktreePath)) {
		return { reused: true };
	}
	await mkdir(dirname(worktreePath), { recursive: true });
	const proc = Bun.spawn(["git", "worktree", "add", worktreePath, sha], {
		cwd: cachePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	// If `git worktree add` failed, it may be because a concurrent call won the race.
	// Re-check the path: if still missing, it's a real failure.
	if (exitCode !== 0 && !(await exists(worktreePath))) {
		throw new MegasthenesError("clone_failed", `git worktree add failed with exit code ${exitCode}`, {
			isRetryable: true,
		});
	}
	return { reused: exitCode !== 0 };
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
		"megasthenes.git.clone.filter": "blob:none",
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
			{ isRetryable: false },
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
