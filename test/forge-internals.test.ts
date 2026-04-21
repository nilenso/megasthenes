import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCachedRepo, removeWorktree, withCloneLock } from "../src/forge/git";
import { createTestRepo, git, type TestRepo } from "./helpers/git";

// Count git processes started while running a closure by wrapping Bun.spawn.
// Verifies "no network call" for ensureCachedRepo's reuse-cache branch.
function countGitSpawnsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; spawns: string[][] }> {
	const originalSpawn = Bun.spawn.bind(Bun) as typeof Bun.spawn;
	const spawns: string[][] = [];
	// Bun.spawn has multiple overloads — we only care about the array form git uses here.
	(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: unknown, opts?: unknown) => {
		if (Array.isArray(cmd) && typeof cmd[0] === "string" && cmd[0] === "git") {
			spawns.push(cmd as string[]);
		}
		return (originalSpawn as unknown as (c: unknown, o?: unknown) => ReturnType<typeof Bun.spawn>)(cmd, opts);
	}) as typeof Bun.spawn;
	return fn()
		.then((result) => ({ result, spawns }))
		.finally(() => {
			(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
		});
}

describe("forge internals", () => {
	let workRoot: string;
	let testRepo: TestRepo;

	beforeAll(async () => {
		workRoot = await mkdtemp(join(tmpdir(), "forge-internals-"));
		testRepo = await createTestRepo(join(workRoot, "remote"));
	});

	afterAll(async () => {
		await rm(workRoot, { recursive: true, force: true });
	});

	describe("ensureCachedRepo", () => {
		test("cache exists AND commitish present locally → reuse_cache, no network call", async () => {
			const cachePath = join(workRoot, "cache-reuse");
			// Seed the cache with an initial clone.
			const seed = await ensureCachedRepo(cachePath, "HEAD", () => testRepo.url);
			expect(seed.operation).toBe("clone");

			// Second call for a commitish that already resolves locally must not spawn git fetch/clone.
			const { result, spawns } = await countGitSpawnsDuring(() =>
				ensureCachedRepo(cachePath, testRepo.commits[0] as string, () => {
					throw new Error("buildCloneUrl should not be called when reusing cache");
				}),
			);

			expect(result).toEqual({ operation: "reuse_cache", cacheExisted: true });
			// Only allowed spawn: git cat-file -t <commitish> (the existence probe).
			for (const cmd of spawns) {
				expect(cmd.slice(0, 3)).toEqual(["git", "cat-file", "-t"]);
			}
		});

		test("cache exists AND commitish missing → fetch", async () => {
			const cachePath = join(workRoot, "cache-fetch");
			// Start from a clone that does NOT have the later commit: make a separate bare repo
			// with only the first commit, clone it, then push the second commit to the original
			// bare repo (upstream) so a fetch from the cache's origin will actually bring in data.
			// Simpler: clone the real remote, then force-delete its ref to v2.0 locally so it's missing.
			await ensureCachedRepo(cachePath, "v1.0", () => testRepo.url);

			// Make sure the cache now lacks a ref that origin has: delete the v2.0 tag locally.
			await git(cachePath, "tag", "-d", "v2.0");
			// Also detach the HEAD-side commit from local refs by resetting the default branch
			// pointer to v1.0 so commit2 is unreachable locally until we fetch.
			// For a bare repo, update refs to point at commit1 for every local branch.
			const branches = (await git(cachePath, "for-each-ref", "--format=%(refname)", "refs/heads/"))
				.split("\n")
				.filter(Boolean);
			for (const ref of branches) {
				await git(cachePath, "update-ref", ref, testRepo.commits[0] as string);
			}
			// GC would be too aggressive; we only need cat-file to fail for commit2. Since commit2
			// is still present as an object but the test below asks for v2.0 (which we deleted),
			// cat-file -t v2.0 returns non-zero → forces the fetch branch.

			const result = await ensureCachedRepo(cachePath, "v2.0", () => testRepo.url);
			expect(result).toEqual({ operation: "fetch", cacheExisted: true });

			// After fetch, v2.0 must be resolvable.
			const afterTag = await git(cachePath, "rev-parse", "v2.0");
			expect(afterTag).toBe(testRepo.commits[1] as string);
		});

		test("cache directory absent → clone", async () => {
			const cachePath = join(workRoot, "cache-clone");
			expect(existsSync(cachePath)).toBe(false);

			const result = await ensureCachedRepo(cachePath, "HEAD", () => testRepo.url);

			expect(result).toEqual({ operation: "clone", cacheExisted: false });
			expect(existsSync(join(cachePath, "HEAD"))).toBe(true);
		});

		test("cache dir exists but HEAD missing → cleanup + reclone", async () => {
			const cachePath = join(workRoot, "cache-incomplete");
			// Simulate an incomplete prior clone: dir exists, HEAD does not, with a stray file
			// we can verify gets cleaned up.
			await mkdir(cachePath, { recursive: true });
			const strayPath = join(cachePath, "stray-file");
			await writeFile(strayPath, "leftover from failed clone");
			expect(existsSync(strayPath)).toBe(true);

			const result = await ensureCachedRepo(cachePath, "HEAD", () => testRepo.url);

			expect(result).toEqual({ operation: "clone", cacheExisted: false });
			expect(existsSync(strayPath)).toBe(false);
			expect(existsSync(join(cachePath, "HEAD"))).toBe(true);
		});
	});

	describe("withCloneLock", () => {
		test("concurrent same-key callers are serialized (observe ordering)", async () => {
			const order: string[] = [];
			const firstStarted = Promise.withResolvers<void>();
			const releaseFirst = Promise.withResolvers<void>();
			let secondStarted = false;

			const p1 = withCloneLock("key-A", async () => {
				order.push("start-1");
				firstStarted.resolve();
				await releaseFirst.promise;
				order.push("end-1");
				return 1;
			});
			const p2 = withCloneLock("key-A", async () => {
				secondStarted = true;
				order.push("start-2");
				order.push("end-2");
				return 2;
			});

			await firstStarted.promise;
			// While the first holds the lock, the second must not have entered its body.
			expect(order).toEqual(["start-1"]);
			expect(secondStarted).toBe(false);

			releaseFirst.resolve();
			const [r1, r2] = await Promise.all([p1, p2]);

			expect(r1).toBe(1);
			expect(r2).toBe(2);
			expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
		});

		test("lock is released when fn throws (subsequent call proceeds)", async () => {
			await expect(
				withCloneLock("key-B", async () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");

			// If the lock were not released, this call would deadlock; bun:test would time out.
			const v = await withCloneLock("key-B", async () => "ok");
			expect(v).toBe("ok");
		});

		test("different keys do not block each other", async () => {
			const order: string[] = [];
			const aStarted = Promise.withResolvers<void>();
			const releaseA = Promise.withResolvers<void>();

			const pA = withCloneLock("key-C", async () => {
				order.push("start-A");
				aStarted.resolve();
				await releaseA.promise;
				order.push("end-A");
				return "A";
			});

			await aStarted.promise;

			// Different key must run to completion while A is still held.
			const bResult = await withCloneLock("key-D", async () => {
				order.push("start-B");
				order.push("end-B");
				return "B";
			});
			expect(bResult).toBe("B");
			expect(order).toEqual(["start-A", "start-B", "end-B"]);

			releaseA.resolve();
			await pA;
			expect(order).toEqual(["start-A", "start-B", "end-B", "end-A"]);
		});
	});

	describe("removeWorktree", () => {
		test("success → { ok: true }", async () => {
			const cachePath = join(workRoot, "remove-success");
			await ensureCachedRepo(cachePath, "HEAD", () => testRepo.url);
			const worktreePath = join(workRoot, "remove-success-tree");
			await git(cachePath, "worktree", "add", worktreePath, "HEAD");
			expect(existsSync(worktreePath)).toBe(true);

			const result = await removeWorktree(cachePath, worktreePath);

			expect(result).toEqual({ ok: true });
			expect(existsSync(worktreePath)).toBe(false);
		});

		test("already-done marker → { ok: true } (idempotent)", async () => {
			const cachePath = join(workRoot, "remove-idempotent");
			await ensureCachedRepo(cachePath, "HEAD", () => testRepo.url);
			const worktreePath = join(workRoot, "remove-idempotent-tree");
			await git(cachePath, "worktree", "add", worktreePath, "HEAD");

			const first = await removeWorktree(cachePath, worktreePath);
			expect(first).toEqual({ ok: true });

			// Second removal: git will emit "is not a working tree" — must be classified as ok.
			const second = await removeWorktree(cachePath, worktreePath);
			expect(second).toEqual({ ok: true });
		});

		test("real failure → { ok: false, exitCode, stderr }", async () => {
			// cachePath points at a non-git directory → git errors with "not a git repository".
			const nonGitDir = await mkdtemp(join(tmpdir(), "forge-internals-nongit-"));
			try {
				const result = await removeWorktree(nonGitDir, join(nonGitDir, "nope"));
				expect(result.ok).toBe(false);
				if (result.ok) throw new Error("unreachable");
				expect(typeof result.exitCode).toBe("number");
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toMatch(/not a git repository/i);
			} finally {
				await rm(nonGitDir, { recursive: true, force: true });
			}
		});
	});
});
