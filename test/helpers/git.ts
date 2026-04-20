import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface TestRepo {
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
export async function git(cwd: string, ...args: string[]): Promise<string> {
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
export async function createTestRepo(baseDir: string): Promise<TestRepo> {
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
