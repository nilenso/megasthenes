import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupWorktree, connectRepo, type Forge } from "../src/forge";

// =============================================================================
// Test Helpers
// =============================================================================

interface TestRepo {
	/** file:// URL to the bare repo */
	url: string;
	/** Path to the bare repo */
	barePath: string;
	/** SHA of each commit (index 0 = first commit) */
	commits: string[];
	/** Tag names created */
	tags: string[];
}

/** Run a git command and return stdout */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			// Prevent git from prompting
			GIT_TERMINAL_PROMPT: "0",
			// Set committer info for test commits
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
		},
	});
	const stdout = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout.trim();
}

/**
 * Create a test git repository with commits and tags.
 * Returns a file:// URL that can be used with connectRepo.
 *
 * The repo is structured as user/repo to match expected URL parsing.
 */
async function createTestRepo(baseDir: string): Promise<TestRepo> {
	// Structure as user/repo.git to match expected URL format
	const barePath = join(baseDir, "testuser", "testrepo.git");
	const workPath = join(baseDir, "work");

	await mkdir(join(baseDir, "testuser"), { recursive: true });

	// Create bare repo (acts as remote)
	await mkdir(barePath, { recursive: true });
	await git(barePath, "init", "--bare");

	// Clone to working directory
	await git(baseDir, "clone", barePath, "work");

	const commits: string[] = [];
	const tags: string[] = [];

	// Create first commit
	await Bun.write(join(workPath, "README.md"), "# Test Repo\n\nVersion 1");
	await git(workPath, "add", ".");
	await git(workPath, "commit", "-m", "Initial commit");
	commits.push(await git(workPath, "rev-parse", "HEAD"));

	// Create tag v1.0
	await git(workPath, "tag", "v1.0");
	tags.push("v1.0");

	// Create second commit
	await Bun.write(join(workPath, "README.md"), "# Test Repo\n\nVersion 2");
	await git(workPath, "add", ".");
	await git(workPath, "commit", "-m", "Second commit");
	commits.push(await git(workPath, "rev-parse", "HEAD"));

	// Create tag v2.0
	await git(workPath, "tag", "v2.0");
	tags.push("v2.0");

	// Push to bare repo (use HEAD to push current branch regardless of name)
	await git(workPath, "push", "origin", "HEAD", "--tags");

	return {
		url: `file://${barePath}`,
		barePath,
		commits,
		tags,
	};
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
		testDir = join(tmpdir(), `ask-forge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
		const testRepo = await createTestRepo(testDir);

		// Extract values for use in tests (avoids array indexing issues)
		repoUrl = testRepo.url;
		commit1 = testRepo.commits[0] as string;
		commit2 = testRepo.commits[1] as string;

		// Track cache paths to clean up (based on URL parsing behavior)
		// file:///tmp/... or file:///var/... parses to username="tmp" or "var"
		const home = process.env.HOME || "";
		cacheCleanupPaths.push(join(home, ".ask-forge", "repos", "tmp"));
		cacheCleanupPaths.push(join(home, ".ask-forge", "repos", "var"));
		cacheCleanupPaths.push(join(home, ".ask-forge", "repos", "testuser"));
		cacheCleanupPaths.push(join(home, ".ask-forge", "repos", "gitlab-examples"));
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
			expect(repo.localPath).toContain(".ask-forge");
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

		test("throws for non-existent commitish", async () => {
			expect(
				connectRepo(repoUrl, {
					forge: "github",
					commitish: "nonexistent-branch",
				}),
			).rejects.toThrow("Failed to resolve commitish");
		});

		test("throws for invalid URL", async () => {
			expect(connectRepo("not-a-url")).rejects.toThrow();
		});

		test("throws for unknown forge without explicit option", async () => {
			expect(
				connectRepo("https://bitbucket.org/user/repo"),
			).rejects.toThrow("Cannot infer forge from URL");
		});

		test("throws for URL with no path segments", async () => {
			expect(
				connectRepo("https://github.com/", { forge: "github" }),
			).rejects.toThrow("Invalid repo URL");
		});

		test("throws for URL with only one path segment", async () => {
			expect(
				connectRepo("https://github.com/user", { forge: "github" }),
			).rejects.toThrow("Invalid repo URL");
		});

		test("succeeds with explicit forge option for non-standard host", async () => {
			const repo = await connectRepo(repoUrl, { forge: "gitlab" });
			expect(repo.forge.name).toBe("gitlab");
		});
	});

	describe("cleanupWorktree", () => {
		test("removes worktree successfully", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			const readmeBefore = await readFile(join(repo.localPath, "README.md"), "utf-8");
			expect(readmeBefore).toBeDefined();

			const success = await cleanupWorktree(repo);
			expect(success).toBe(true);

			expect(readFile(join(repo.localPath, "README.md"), "utf-8")).rejects.toThrow();
		});

		test("returns false for non-existent worktree", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			await cleanupWorktree(repo);
			const success = await cleanupWorktree(repo);

			expect(success).toBe(false);
		});

		test("after cleanup, repo.localPath directory no longer exists on disk", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });
			expect(existsSync(repo.localPath)).toBe(true);

			const success = await cleanupWorktree(repo);
			expect(success).toBe(true);
			expect(existsSync(repo.localPath)).toBe(false);
		});

		test("cleanup when worktree path is already manually deleted still succeeds via git", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			await rm(repo.localPath, { recursive: true, force: true });
			expect(existsSync(repo.localPath)).toBe(false);

			// git worktree remove --force succeeds even if the directory is gone
			const success = await cleanupWorktree(repo);
			expect(success).toBe(true);

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

			await cleanupWorktree(repo);

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

	describe("inferForge (indirect)", () => {
		test("github.com URL infers github forge (error is not about forge inference)", async () => {
			// connectRepo will fail (repo doesn't exist), but the error must NOT be
			// about forge inference — proving inferForge("github.com") returned "github"
			const err = await connectRepo("https://github.com/testuser/testrepo").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toContain("Cannot infer forge");
		});

		test("gitlab.com URL infers gitlab forge (public repo connects without explicit forge option)", async () => {
			const repo = await connectRepo("https://gitlab.com/gitlab-examples/ci-debug-trace.git");
			expect(repo.forge.name).toBe("gitlab");
			expect(repo.url).toContain("gitlab.com");
		}, 30_000);

		test("custom domain without forge option throws 'Cannot infer forge'", async () => {
			await expect(
				connectRepo("https://git.example.com/user/repo"),
			).rejects.toThrow("Cannot infer forge");
		});
	});

	describe("parseRepoPath (indirect)", () => {
		test("cache path contains parsed username and reponame from URL", async () => {
			const repo = await connectRepo(repoUrl, { forge: "github" });

			// repoUrl is file:// — parseRepoPath extracts the first two path segments
			// The cache structure is ~/.ask-forge/repos/{username}/{reponame}/repo
			const url = new URL(repoUrl);
			const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
			const expectedSegment = join(parts[0], parts[1], "repo");

			expect(repo.cachePath).toContain(expectedSegment);
		});

		test(".git suffix is stripped from reponame in cache path", async () => {
			// repoUrl ends in .git (file:///...testuser/testrepo.git)
			const repo = await connectRepo(repoUrl, { forge: "github" });

			const url = new URL(repoUrl);
			const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
			const parsedReponame = parts[1];

			// The parsed reponame should not end with .git
			expect(parsedReponame).not.toMatch(/\.git$/);

			const home = homedir();
			const expectedCachePath = resolve(home, ".ask-forge", "repos", parts[0], parsedReponame, "repo");
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
