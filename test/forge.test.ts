import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MegasthenesError } from "../src/errors";
import { cleanupRepo, connectRepo, type Forge, inferForge, type Repo } from "../src/forge";
import type { ErrorType } from "../src/types";
import { createTestRepo } from "./helpers/git";

// =============================================================================
// Test Helpers
// =============================================================================

async function expectConnectError(promise: Promise<unknown>, errorType: ErrorType): Promise<void> {
	const err = await promise.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(MegasthenesError);
	expect((err as MegasthenesError).errorType).toBe(errorType);
}

// =============================================================================
// Test Suite
// =============================================================================

describe("forge", () => {
	// Fixture: created once for all tests in this suite
	let testDir: string;
	let repoUrl: string;
	let commit1: string; // v1.0 - Initial commit
	let commit2: string; // v2.0 - Second commit (HEAD)

	// Cache cleanup paths
	const cacheCleanupPaths: string[] = [];

	beforeAll(async () => {
		// Create test directory and repository once for all tests
		testDir = join(tmpdir(), `megasthenes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
		const testRepo = await createTestRepo(testDir);

		// Extract values for use in tests (avoids array indexing issues)
		repoUrl = testRepo.url;
		commit1 = testRepo.commits[0] as string;
		commit2 = testRepo.commits[1] as string;

		// Track cache paths to clean up (based on URL parsing behavior)
		// file:///tmp/... or file:///var/... parses to username="tmp" or "var"
		const home = process.env.HOME || "";
		cacheCleanupPaths.push(join(home, ".megasthenes", "repos", "tmp"));
		cacheCleanupPaths.push(join(home, ".megasthenes", "repos", "var"));
		cacheCleanupPaths.push(join(home, ".megasthenes", "repos", "testuser"));
	});

	afterAll(async () => {
		// Clean up shared cache once after all tests to maximize repo reuse during the suite
		for (const cachePath of cacheCleanupPaths) {
			try {
				await rm(cachePath, { recursive: true, force: true });
			} catch {
				console.log(`Cleanup of cache path failed: ${cachePath}`);
			}
		}

		// Clean up test directory
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("connectRepo", () => {
		test("clones repo and creates worktree", async () => {
			// Use forge: "github" for local file:// URLs (forge is required for non-github/gitlab URLs)
			const repo = await connectRepo(repoUrl, { forge: "github" });

			expect(repo.url).toBe(repoUrl);
			expect(repo.localPath).toContain(".megasthenes");
			expect(repo.commitish).toBe(commit2);

			const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 2");
		});

		test("checks out specific tag", async () => {
			const repo = await connectRepo(repoUrl, {
				forge: "github",
				commitish: "v1.0",
			});

			expect(repo.commitish).toBe(commit1);

			const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 1");
		});

		test("checks out specific SHA", async () => {
			const repo = await connectRepo(repoUrl, {
				forge: "github",
				commitish: commit1,
			});

			expect(repo.commitish).toBe(commit1);

			const readme = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 1");
		});

		test("reuses cached bare repo for different commitish", async () => {
			const repo1 = await connectRepo(repoUrl, {
				forge: "github",
				commitish: "v1.0",
			});
			const repo2 = await connectRepo(repoUrl, {
				forge: "github",
				commitish: "v2.0",
			});

			expect(repo1.cachePath).toBe(repo2.cachePath);
			expect(repo1.localPath).not.toBe(repo2.localPath);

			const readme1 = await readFile(join(repo1.localPath, "README.md"), "utf-8");
			const readme2 = await readFile(join(repo2.localPath, "README.md"), "utf-8");
			expect(readme1).toContain("Version 1");
			expect(readme2).toContain("Version 2");
		});

		test("reuses existing worktree for same commitish", async () => {
			const repo1 = await connectRepo(repoUrl, { forge: "github", commitish: "v1.0" });
			const repo2 = await connectRepo(repoUrl, { forge: "github", commitish: "v1.0" });

			expect(repo1.localPath).toBe(repo2.localPath);
			expect(repo1.cachePath).toBe(repo2.cachePath);
			expect(repo1.commitish).toBe(repo2.commitish);

			const readme = await readFile(join(repo2.localPath, "README.md"), "utf-8");
			expect(readme).toContain("Version 1");
		});

		test("parallel calls with different commitish share cache", async () => {
			const results = await Promise.all([
				connectRepo(repoUrl, { forge: "github", commitish: "v1.0" }),
				connectRepo(repoUrl, { forge: "github", commitish: "v2.0" }),
			]);

			expect(results[0].commitish).toBe(commit1);
			expect(results[1].commitish).toBe(commit2);
			expect(results[0].cachePath).toBe(results[1].cachePath);
			expect(results[0].localPath).not.toBe(results[1].localPath);
		});

		test("throws invalid_commitish for non-existent commitish", async () => {
			await expectConnectError(
				connectRepo(repoUrl, { forge: "github", commitish: "nonexistent-branch" }),
				"invalid_commitish",
			);
		});

		test("throws for invalid URL", async () => {
			expect(connectRepo("not-a-url")).rejects.toThrow();
		});

		test("throws invalid_config for unknown forge without explicit option", async () => {
			await expectConnectError(connectRepo("https://bitbucket.org/user/repo"), "invalid_config");
		});

		test("throws invalid_config for URL with no path segments", async () => {
			await expectConnectError(connectRepo("https://github.com/", { forge: "github" }), "invalid_config");
		});

		test("throws invalid_config for URL with only one path segment", async () => {
			await expectConnectError(connectRepo("https://github.com/user", { forge: "github" }), "invalid_config");
		});

		test("succeeds with explicit forge option for non-standard host", async () => {
			const repo = await connectRepo(repoUrl, { forge: "gitlab" });
			expect(repo.forge.name).toBe("gitlab");
		});
	});

	describe("cleanupRepo", () => {
		test("removes worktree successfully", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			const readmeBefore = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readmeBefore).toBeDefined();

			const result = await cleanupRepo(repo);
			expect(result.ok).toBe(true);

			expect(readFile(join(repo.localPath, "README.md"), "utf-8")).rejects.toThrow();
		});

		test("returns { ok: true } when worktree is already cleaned up (idempotent)", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			await cleanupRepo(repo);
			const result = await cleanupRepo(repo);

			// Second cleanup: git says "is not a working tree" — classified as success
			// so repeated calls don't masquerade as leaks.
			expect(result.ok).toBe(true);
		});

		test("returns failure details (path + exit info) on unexpected error", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });
			const nonGitDir = await mkdtemp(join(tmpdir(), "forge-test-nongit-"));
			const broken: Repo = { ...repo, cachePath: nonGitDir };

			const result = await cleanupRepo(broken);

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable: narrowed by assertion above");
			const details = result.details as { path: string; exitCode: number; stderr: string };
			expect(details.path).toBe(broken.localPath);
			expect(typeof details.exitCode).toBe("number");
			expect(details.exitCode).not.toBe(0);
			expect(details.stderr).toMatch(/not a git repository/i);

			await rm(nonGitDir, { recursive: true, force: true });
		});

		test("after cleanup, repo.localPath directory no longer exists on disk", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });
			expect(existsSync(repo.localPath)).toBe(true);

			const result = await cleanupRepo(repo);
			expect(result.ok).toBe(true);
			expect(existsSync(repo.localPath)).toBe(false);
		});

		test("cleanup when worktree path is already manually deleted still succeeds via git", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			await rm(repo.localPath, { recursive: true, force: true });
			expect(existsSync(repo.localPath)).toBe(false);

			// git worktree remove --force succeeds even if the directory is gone
			const result = await cleanupRepo(repo);
			expect(result.ok).toBe(true);

			// After cleanup, the worktree is also removed from git's tracking
			const proc = Bun.spawn(["git", "worktree", "list"], {
				cwd: repo.cachePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			await proc.exited;
			expect(stdout).not.toContain(repo.localPath);
		});

		test("worktree is absent from git worktree list after cleanup", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			await cleanupRepo(repo);

			const proc = Bun.spawn(["git", "worktree", "list"], {
				cwd: repo.cachePath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			await proc.exited;

			expect(stdout).not.toContain(repo.localPath);
		});
	});

	describe("withCloneLock (via connectRepo)", () => {
		test("concurrent calls with same commitish all resolve to same localPath", async () => {
			const results = await Promise.all([
				connectRepo(repoUrl, { forge: "github", commitish: "v1.0" }),
				connectRepo(repoUrl, { forge: "github", commitish: "v1.0" }),
				connectRepo(repoUrl, { forge: "github", commitish: "v1.0" }),
			]);

			// All 3 calls must succeed and agree on localPath and commitish
			expect(results).toHaveLength(3);
			for (const repo of results) {
				expect(repo.localPath).toBe(results[0].localPath);
				expect(repo.commitish).toBe(results[0].commitish);
			}
		});

		test("lock is released after error (subsequent call succeeds)", async () => {
			try {
				await connectRepo(repoUrl, {
					forge: "github",
					commitish: "nonexistent-ref-xyz",
				});
			} catch {
				// Expected to throw
			}

			const repo = await connectRepo(repoUrl, {
				forge: "github",
				commitish: "v1.0",
			});
			expect(repo.commitish).toBe(commit1);
		});

		test("concurrent calls with different commitish run without deadlock", async () => {
			const results = await Promise.all([
				connectRepo(repoUrl, { forge: "github", commitish: "v1.0" }),
				connectRepo(repoUrl, { forge: "github", commitish: "v2.0" }),
			]);

			expect(results[0].commitish).toBe(commit1);
			expect(results[1].commitish).toBe(commit2);
			expect(results[0].localPath).not.toBe(results[1].localPath);
		});
	});

	describe("inferForge", () => {
		test("github.com URL infers github forge", () => {
			expect(inferForge("https://github.com/owner/repo")).toBe("github");
			expect(inferForge("https://github.com/owner/repo.git")).toBe("github");
		});

		test("gitlab.com URL infers gitlab forge", () => {
			expect(inferForge("https://gitlab.com/owner/repo")).toBe("gitlab");
			expect(inferForge("https://gitlab.com/owner/repo.git")).toBe("gitlab");
		});

		test("unknown domain returns null", () => {
			expect(inferForge("https://git.example.com/user/repo")).toBeNull();
		});

		test("custom domain without forge option throws invalid_config", async () => {
			await expectConnectError(connectRepo("https://git.example.com/user/repo"), "invalid_config");
		});
	});

	describe("parseRepoPath (indirect)", () => {
		test("cache path contains parsed username and reponame from URL", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			// repoUrl is file:// — parseRepoPath extracts the first two path segments
			// The cache structure is ~/.megasthenes/repos/{username}/{reponame}/repo
			const url = new URL(repoUrl);
			const parts = url.pathname
				.replace(/^\//, "")
				.replace(/\.git$/, "")
				.split("/");
			const [username, reponame] = parts;
			if (!username || !reponame) throw new Error(`unexpected URL shape: ${url.pathname}`);
			const expectedSegment = join(username, reponame, "repo");

			expect(repo.cachePath).toContain(expectedSegment);
		});

		test(".git suffix is stripped from reponame in cache path", async () => {
			// repoUrl ends in .git (file:///...testuser/testrepo.git)
			const repo = await connectRepo(repoUrl, { forge: "github" });

			const url = new URL(repoUrl);
			const parts = url.pathname
				.replace(/^\//, "")
				.replace(/\.git$/, "")
				.split("/");
			const [username, reponame] = parts;
			if (!username || !reponame) throw new Error(`unexpected URL shape: ${url.pathname}`);

			// The parsed reponame should not end with .git
			expect(reponame).not.toMatch(/\.git$/);

			const home = homedir();
			const expectedCachePath = resolve(home, ".megasthenes", "repos", username, reponame, "repo");
			expect(repo.cachePath).toBe(expectedCachePath);
		});
	});

	describe("buildCloneUrl (via repo.forge)", () => {
		let githubForge: Forge;
		let gitlabForge: Forge;

		beforeAll(async () => {
			const [githubRepo, gitlabRepo] = await Promise.all([
				connectRepo(repoUrl, { forge: "github" }),
				connectRepo(repoUrl, { forge: "gitlab" }),
			]);
			githubForge = githubRepo.forge;
			gitlabForge = gitlabRepo.forge;
		});

		test("GitHub forge: buildCloneUrl without token returns original URL", () => {
			const url = "https://github.com/owner/repo";
			expect(githubForge.buildCloneUrl(url)).toBe(url);
		});

		test("GitHub forge: buildCloneUrl with token embeds token as username", () => {
			const url = "https://github.com/owner/repo";
			const result = githubForge.buildCloneUrl(url, "ghp_xxx");

			const parsed = new URL(result);
			expect(parsed.username).toBe("ghp_xxx");
			expect(parsed.hostname).toBe("github.com");
			expect(parsed.pathname).toBe("/owner/repo");
		});

		test("GitLab forge: buildCloneUrl without token returns original URL", () => {
			const url = "https://gitlab.com/owner/repo";
			expect(gitlabForge.buildCloneUrl(url)).toBe(url);
		});

		test("GitLab forge: buildCloneUrl with token embeds oauth2:token", () => {
			const url = "https://gitlab.com/owner/repo";
			const result = gitlabForge.buildCloneUrl(url, "glpat_xxx");

			const parsed = new URL(result);
			expect(parsed.username).toBe("oauth2");
			expect(parsed.password).toBe("glpat_xxx");
			expect(parsed.hostname).toBe("gitlab.com");
			expect(parsed.pathname).toBe("/owner/repo");
		});
	});
});
