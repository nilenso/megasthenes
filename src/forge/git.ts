import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MegasthenesError } from "../errors";

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

export async function withCloneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

export async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function commitishExistsLocally(repoPath: string, commitish: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "cat-file", "-t", commitish], {
		cwd: repoPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = (await new Response(proc.stdout).text()).trim();
	const exitCode = await proc.exited;
	return exitCode === 0 && (output === "commit" || output === "tag");
}

export type CacheOperation = "fetch" | "reuse_cache" | "clone";

export interface CachePhaseResult {
	operation: CacheOperation;
	cacheExisted: boolean;
}

export async function ensureCachedRepo(
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
				retryability: "yes",
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
			retryability: "yes",
		});
	}
	return { operation: "clone", cacheExisted: false };
}

export async function resolveCommitish(cachePath: string, commitish: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", commitish], {
		cwd: cachePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const resolved = (await new Response(proc.stdout).text()).trim();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new MegasthenesError("invalid_commitish", `Failed to resolve commitish: ${commitish}`, {
			retryability: "no",
		});
	}
	return resolved;
}

export async function ensureWorktree(
	cachePath: string,
	sha: string,
	worktreePath: string,
): Promise<{ reused: boolean }> {
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
			retryability: "yes",
		});
	}
	return { reused: exitCode !== 0 };
}

// Stderr substrings that indicate there was nothing to remove: git already
// doesn't track the worktree, or the path is gone. Matching any of these
// means the desired end-state is already achieved, so removal is treated as
// successful (idempotent remove) rather than failed.
const CLEANUP_ALREADY_DONE_MARKERS = ["is not a working tree", "No such file or directory"] as const;

export type RemoveWorktreeResult = { ok: true } | { ok: false; exitCode: number; stderr: string };

/**
 * Run `git worktree remove --force` for `worktreePath` against the bare cache at
 * `cachePath`. Returns a structured result so callers can map outcomes without
 * inspecting git internals.
 *
 * Idempotent: if git reports the worktree is already gone (see
 * `CLEANUP_ALREADY_DONE_MARKERS`), the result is `{ ok: true }`.
 */
export async function removeWorktree(cachePath: string, worktreePath: string): Promise<RemoveWorktreeResult> {
	const proc = Bun.spawn(["git", "worktree", "remove", "--force", worktreePath], {
		cwd: cachePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (exitCode === 0) return { ok: true };
	if (CLEANUP_ALREADY_DONE_MARKERS.some((marker) => stderr.includes(marker))) {
		return { ok: true };
	}
	return { ok: false, exitCode, stderr: stderr.trim() };
}
