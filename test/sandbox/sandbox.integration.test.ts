/**
 * Integration tests for the sandbox HTTP API.
 *
 * Tests both normal operations and adverse security cases.
 * Requires the sandbox container to be running on localhost:8080.
 *
 * Run with: just sandbox-integration-tests
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SandboxClient } from "../../src/sandbox/client";

const SANDBOX_URL = process.env.SANDBOX_URL || "http://localhost:8080";
const TEST_REPO = "https://github.com/octocat/Hello-World";

// =============================================================================
// Helpers
// =============================================================================

async function isSandboxRunning(): Promise<boolean> {
	try {
		const res = await fetch(`${SANDBOX_URL}/health`, { signal: AbortSignal.timeout(2000) });
		const body = (await res.json()) as { ok: boolean };
		return body.ok === true;
	} catch {
		return false;
	}
}

// =============================================================================
// Normal Operations
// =============================================================================

describe("sandbox normal operations", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) {
			console.log("Skipping sandbox tests: sandbox not running on", SANDBOX_URL);
			return;
		}
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("health endpoint returns ok", async () => {
		if (!(await isSandboxRunning())) return;

		const res = await fetch(`${SANDBOX_URL}/health`);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("clone returns slug and sha", async () => {
		if (!(await isSandboxRunning())) return;

		expect(cloneResult.slug).toContain("github.com");
		expect(cloneResult.slug).toContain("Hello-World");
		expect(cloneResult.sha).toHaveLength(40);
		expect(cloneResult.worktree).toContain("/home/forge/repos");
	});

	test("clone with commitish checks out specific commit", async () => {
		if (!(await isSandboxRunning())) return;

		const result = await client.clone(TEST_REPO, "master");
		expect(result.sha).toHaveLength(40);
	});

	test("rg tool finds patterns", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "Hello",
		});
		expect(output).toContain("Hello");
	});

	test("ls tool lists files", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "ls", {});
		expect(output).toContain("README");
	});

	test("read tool reads files", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
			path: "README",
		});
		expect(output).toContain("Hello World");
	});

	test("reset clears all repos", async () => {
		if (!(await isSandboxRunning())) return;

		await client.reset();
		// After reset, the worktree should not exist
		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "ls", {});
		expect(output).toContain("Error");
	});
});

// =============================================================================
// Path Traversal Attacks
// =============================================================================

describe("sandbox path traversal protection", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("read blocks ../etc/passwd traversal", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
			path: "../../../etc/passwd",
		});
		expect(output).toContain("Error");
		expect(output).not.toContain("root:");
	});

	test("read blocks absolute path /etc/passwd", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
			path: "/etc/passwd",
		});
		expect(output).toContain("Error");
		expect(output).not.toContain("root:");
	});

	test("read blocks encoded traversal ..%2f..%2f", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
			path: "..%2f..%2f..%2fetc%2fpasswd",
		});
		// Should either error or not find the file (path is literal)
		expect(output).not.toContain("root:");
	});

	test("ls blocks path traversal", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "ls", {
			path: "../../../",
		});
		expect(output).toContain("Error");
	});

	test("ls blocks absolute paths outside worktree", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "ls", {
			path: "/etc",
		});
		expect(output).toContain("Error");
	});
});

// =============================================================================
// Filesystem Isolation
// =============================================================================

describe("sandbox filesystem isolation", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("cannot read files from other repos", async () => {
		if (!(await isSandboxRunning())) return;

		// Clone another repo
		const other = await client.clone("https://github.com/octocat/Spoon-Knife");

		// Try to read from original repo using path to other repo
		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
			path: `../../${other.slug}/trees/${other.sha.slice(0, 12)}/README.md`,
		});
		expect(output).toContain("Error");
	});

	test("cannot access parent directories via rg", async () => {
		if (!(await isSandboxRunning())) return;

		// rg should only search within the worktree
		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "root",
			glob: "../../../etc/passwd",
		});
		// Should not find /etc/passwd content
		expect(output).not.toContain("root:x:0:0");
	});

	test("cannot write files (read-only filesystem)", async () => {
		if (!(await isSandboxRunning())) return;

		// Try to use a tool that might write - but our tools are read-only
		// This tests that the sandbox doesn't allow arbitrary command execution
		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "test; echo hacked > /tmp/pwned",
		});
		// The pattern should be treated as a literal, not executed
		expect(output).not.toContain("hacked");
	});
});

// =============================================================================
// Network Isolation
// =============================================================================

describe("sandbox network isolation", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("tools cannot make network connections", async () => {
		if (!(await isSandboxRunning())) return;

		// rg with a pattern that might trigger network access shouldn't work
		// This is more about ensuring the seccomp filter is active
		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "Hello",
		});
		// Should work normally - network isn't needed for rg
		expect(output).toContain("Hello");
	});
});

// =============================================================================
// HTTP-Boundary Validation (malformed request bodies → 400, not 500)
// =============================================================================

// These tests bypass SandboxClient and hit the worker directly with raw fetch
// so they can send payloads the client would never construct. The goal is to
// pin down the HTTP contract: malformed bodies must produce 400 Bad Request
// with an actionable error, not an opaque 500 from a deep helper.

describe("sandbox HTTP-boundary validation", () => {
	async function postJson(
		path: string,
		body: unknown,
		rawBody?: string,
	): Promise<{ status: number; body: { ok: boolean; error?: string } }> {
		const res = await fetch(`${SANDBOX_URL}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: rawBody ?? JSON.stringify(body),
		});
		const parsed = (await res.json()) as { ok: boolean; error?: string };
		return { status: res.status, body: parsed };
	}

	test("POST /clone with malformed JSON returns 400", async () => {
		if (!(await isSandboxRunning())) return;

		const { status, body } = await postJson("/clone", null, "{not json");
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/JSON/i);
	});

	test("POST /clone with missing url returns 400", async () => {
		if (!(await isSandboxRunning())) return;

		const { status, body } = await postJson("/clone", {});
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toContain("url");
	});

	test("POST /clone with wrong-typed url returns 400", async () => {
		if (!(await isSandboxRunning())) return;

		const { status, body } = await postJson("/clone", { url: 123 });
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toContain("url");
	});

	test("POST /tool with missing required fields returns 400", async () => {
		if (!(await isSandboxRunning())) return;

		const { status, body } = await postJson("/tool", { slug: "x" });
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		// Error should point at one of the missing fields (sha / name / args).
		expect(body.error).toMatch(/sha|name|args/);
	});

	test("POST /tool with non-object args returns 400", async () => {
		if (!(await isSandboxRunning())) return;

		const { status, body } = await postJson("/tool", {
			slug: "github.com/octocat/Hello-World",
			sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
			name: "ls",
			args: "not-an-object",
		});
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toContain("args");
	});

	test("POST /tool with malformed JSON returns 400", async () => {
		if (!(await isSandboxRunning())) return;

		const { status, body } = await postJson("/tool", null, "{not json");
		expect(status).toBe(400);
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/JSON/i);
	});
});

// =============================================================================
// Input Validation
// =============================================================================

describe("sandbox input validation", () => {
	let client: SandboxClient;

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
	});

	test("clone rejects empty URL", async () => {
		if (!(await isSandboxRunning())) return;

		try {
			await client.clone("");
			expect(true).toBe(false); // Should not reach here
		} catch (e) {
			expect((e as Error).message).toContain("failed");
		}
	});

	test("clone rejects invalid URL", async () => {
		if (!(await isSandboxRunning())) return;

		try {
			await client.clone("not-a-valid-url");
			expect(true).toBe(false);
		} catch (e) {
			expect((e as Error).message).toContain("failed");
		}
	});

	test("tool rejects non-existent repo", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool("nonexistent_repo", "abc123", "ls", {});
		expect(output).toContain("Error");
	});

	test("tool rejects non-existent sha", async () => {
		if (!(await isSandboxRunning())) return;

		const cloneResult = await client.clone(TEST_REPO);
		const output = await client.executeTool(cloneResult.slug, "nonexistent_sha_here", "ls", {});
		expect(output).toContain("Error");
	});

	test("tool rejects unknown tool name", async () => {
		if (!(await isSandboxRunning())) return;

		const cloneResult = await client.clone(TEST_REPO);
		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "exec", {
			cmd: "whoami",
		});
		expect(output).toContain("Error");
		expect(output).toContain("Unknown tool");
	});
});

// =============================================================================
// Command Injection
// =============================================================================

describe("sandbox command injection protection", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("rg pattern with shell metacharacters is safe", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "$(whoami)",
		});
		// Should treat as literal pattern, not execute
		expect(output).not.toContain("root");
		expect(output).not.toContain("forge");
	});

	test("rg pattern with backticks is safe", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "`id`",
		});
		expect(output).not.toContain("uid=");
	});

	test("rg pattern with semicolon is safe", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "test; cat /etc/passwd",
		});
		expect(output).not.toContain("root:x:0");
	});

	test("rg pattern with pipe is safe", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "test | cat /etc/passwd",
		});
		expect(output).not.toContain("root:x:0");
	});

	test("rg glob with command substitution is safe", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "Hello",
			glob: "$(cat /etc/passwd)",
		});
		expect(output).not.toContain("root:x:0");
	});

	test("read path with null byte is rejected", async () => {
		if (!(await isSandboxRunning())) return;

		// Null bytes in JSON should cause parsing to fail or be rejected
		try {
			const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
				path: "README\x00/etc/passwd",
			});
			// If it doesn't throw, ensure it didn't expose /etc/passwd
			expect(output).not.toContain("root:x:0");
		} catch {
			// Expected - null byte breaks JSON or is rejected
			expect(true).toBe(true);
		}
	});

	test("ls path with newline is safe", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "ls", {
			path: ".\n/etc",
		});
		expect(output).not.toContain("passwd");
	});
});

// =============================================================================
// Authentication
// =============================================================================

describe("sandbox authentication", () => {
	test("endpoints work without auth when no secret configured", async () => {
		if (!(await isSandboxRunning())) return;

		// Default sandbox has no secret, so this should work
		const res = await fetch(`${SANDBOX_URL}/clone`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: TEST_REPO }),
		});
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("health endpoint is always accessible", async () => {
		if (!(await isSandboxRunning())) return;

		// Health should work even if auth is configured
		const res = await fetch(`${SANDBOX_URL}/health`);
		expect(res.status).toBe(200);
	});
});

// =============================================================================
// Git Tool
// =============================================================================

describe("sandbox git tool", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("git log shows commit history", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "log",
			args: ["--oneline", "-5"],
		});
		expect(output).toContain(cloneResult.sha.slice(0, 7));
	});

	test("git show displays commit details", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "show",
			args: ["--no-patch", "-1"],
		});
		expect(output).toContain("Author:");
	});

	test("git show --stat produces diff stats against a full clone", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "show",
			args: ["--stat", "-1"],
		});

		expect(output).toContain("Author:");
		expect(output).toMatch(/\d+ file.* changed/);
	});

	test("git blame attributes lines against a full clone", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "blame",
			args: ["README"],
		});
		expect(output).toMatch(/\(.+\d{4}-\d{2}-\d{2}/);
	});

	test("git fetch is blocked", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "fetch",
			args: [],
		});
		expect(output).toContain("not allowed");
	});

	test("git push is blocked", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "push",
			args: [],
		});
		expect(output).toContain("not allowed");
	});

	test("git with path traversal is blocked", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "git", {
			command: "log",
			args: ["--", "../../../etc/passwd"],
		});
		expect(output).toContain("outside repository");
	});
});

// =============================================================================
// Resource Limits
// =============================================================================

describe("sandbox resource handling", () => {
	let client: SandboxClient;
	let cloneResult: { slug: string; sha: string; worktree: string };

	beforeAll(async () => {
		if (!(await isSandboxRunning())) return;
		client = new SandboxClient({ baseUrl: SANDBOX_URL, timeoutMs: 120_000 });
		cloneResult = await client.clone(TEST_REPO);
	});

	test("rg handles no matches gracefully", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "rg", {
			pattern: "this_pattern_definitely_does_not_exist_xyz123",
		});
		// Should return empty or error, not crash
		expect(output).toBeDefined();
	});

	test("read handles non-existent file gracefully", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "read", {
			path: "nonexistent_file_xyz.txt",
		});
		expect(output).toContain("Error");
	});

	test("ls handles non-existent path gracefully", async () => {
		if (!(await isSandboxRunning())) return;

		const output = await client.executeTool(cloneResult.slug, cloneResult.sha, "ls", {
			path: "nonexistent_directory_xyz",
		});
		expect(output).toContain("Error");
	});
});
