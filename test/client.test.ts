import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/index";
import { nullLogger } from "../src/logger";

// =============================================================================
// Test Helpers
// =============================================================================

interface TestRepo {
	url: string;
	barePath: string;
	commits: string[];
	tags: string[];
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
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

async function createTestRepo(baseDir: string): Promise<TestRepo> {
	const barePath = join(baseDir, "testuser", "testrepo.git");
	const workPath = join(baseDir, "work");

	await mkdir(join(baseDir, "testuser"), { recursive: true });
	await mkdir(barePath, { recursive: true });
	await git(barePath, "init", "--bare");
	await git(baseDir, "clone", barePath, "work");

	const commits: string[] = [];
	const tags: string[] = [];

	// First commit with some code files
	await Bun.write(join(workPath, "README.md"), "# Test Project\n\nA test project for integration tests.");
	await Bun.write(join(workPath, "package.json"), JSON.stringify({ name: "test-project", version: "1.0.0" }, null, 2));
	await Bun.write(join(workPath, "src", "index.ts"), "export const greeting = 'hello';");
	await git(workPath, "add", ".");
	await git(workPath, "commit", "-m", "Initial commit");
	commits.push(await git(workPath, "rev-parse", "HEAD"));
	await git(workPath, "tag", "v1.0.0");
	tags.push("v1.0.0");

	// Second commit
	await Bun.write(join(workPath, "src", "utils.ts"), "export function add(a: number, b: number) { return a + b; }");
	await git(workPath, "add", ".");
	await git(workPath, "commit", "-m", "Add utils");
	commits.push(await git(workPath, "rev-parse", "HEAD"));
	await git(workPath, "tag", "v2.0.0");
	tags.push("v2.0.0");

	await git(workPath, "push", "origin", "HEAD", "--tags");

	return { url: `file://${barePath}`, barePath, commits, tags };
}

function createTestClient() {
	return new Client({}, nullLogger);
}

// =============================================================================
// Test Suite
// =============================================================================

describe("Client", () => {
	let testDir: string;
	let testRepo: TestRepo;
	const cacheCleanupPaths: string[] = [];

	beforeAll(async () => {
		testDir = join(tmpdir(), `megasthenes-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		await mkdir(testDir, { recursive: true });
		testRepo = await createTestRepo(testDir);

		const home = process.env.HOME || "";
		cacheCleanupPaths.push(join(home, ".megasthenes", "repos", "tmp"));
		cacheCleanupPaths.push(join(home, ".megasthenes", "repos", "var"));
	});

	afterAll(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	afterEach(async () => {
		for (const cachePath of cacheCleanupPaths) {
			try {
				await rm(cachePath, { recursive: true, force: true });
			} catch {
				// Ignore
			}
		}
	});

	test("connects to repository and creates session", async () => {
		const client = createTestClient();

		const session = await client.connect(testRepo.url, { forge: "github" });

		expect(session.id).toBeDefined();
		expect(session.repo.url).toBe(testRepo.url);
		expect(session.repo.commitish).toBe(testRepo.commits[1] ?? "");

		// Verify we can read files from the worktree
		const readme = await readFile(join(session.repo.localPath, "README.md"), "utf-8");
		expect(readme).toContain("Test Project");

		session.close();
	});

	test("connects to specific commitish", async () => {
		const client = createTestClient();

		const session = await client.connect(testRepo.url, {
			forge: "github",
			commitish: "v1.0.0",
		});

		expect(session.repo.commitish).toBe(testRepo.commits[0] ?? "");

		// v1.0.0 should NOT have utils.ts
		const files = await readFile(join(session.repo.localPath, "src", "index.ts"), "utf-8");
		expect(files).toContain("greeting");

		await expect(readFile(join(session.repo.localPath, "src", "utils.ts"), "utf-8")).rejects.toThrow();

		session.close();
	});

	test("creates multiple sessions from same client", async () => {
		const client = createTestClient();

		// Connect to same repo with different commits
		const [session1, session2] = await Promise.all([
			client.connect(testRepo.url, { forge: "github", commitish: "v1.0.0" }),
			client.connect(testRepo.url, { forge: "github", commitish: "v2.0.0" }),
		]);

		// Different sessions
		expect(session1.id).not.toBe(session2.id);

		// Different commits
		expect(session1.repo.commitish).toBe(testRepo.commits[0] ?? "");
		expect(session2.repo.commitish).toBe(testRepo.commits[1] ?? "");

		// Different worktrees
		expect(session1.repo.localPath).not.toBe(session2.repo.localPath);

		// Same cache path (shared bare repo)
		expect(session1.repo.cachePath).toBe(session2.repo.cachePath);

		session1.close();
		session2.close();
	});
});
