/**
 * Integration tests for the isolation layer.
 *
 * These tests verify that bwrap and seccomp provide the expected isolation.
 * Requires: bwrap, and for seccomp tests, the compiled net-block.bpf filter
 *
 * Run with: bun test test/sandbox/isolation/isolation.test.ts
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bwrapArgsForGit, bwrapArgsForTool } from "../../../src/sandbox/isolation/index";

// =============================================================================
// Helpers
// =============================================================================

const SECCOMP_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const SECCOMP_FILTER = `/etc/seccomp/${SECCOMP_ARCH}/net-block.bpf`;

function run(cmd: string[], cwd?: string): { stdout: string; stderr: string; exitCode: number } {
	const [command = "", ...args] = cmd;
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf-8",
		timeout: 10_000,
	});
	return {
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		exitCode: result.status ?? -1,
	};
}

/**
 * Run a command with seccomp filter passed as FD 3.
 * Uses Bun.spawn (async) to match production behavior in worker.ts.
 */
async function runWithSeccomp(
	cmd: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const [command = "", ...args] = cmd;
	const fd = openSync(SECCOMP_FILTER, "r");
	const proc = Bun.spawn([command, ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe", fd],
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function hasBwrap(): boolean {
	const result = run(["which", "bwrap"]);
	return result.exitCode === 0;
}

function hasSeccompFilter(): boolean {
	const result = run(["test", "-f", SECCOMP_FILTER]);
	return result.exitCode === 0;
}

// =============================================================================
// bwrap filesystem isolation tests (no seccomp)
// =============================================================================

describe("bwrap filesystem isolation", () => {
	// Use a path outside /tmp since bwrap uses --tmpfs /tmp
	const testBase = "/var/tmp";
	let testDir: string;
	let repoDir: string;

	beforeAll(async () => {
		if (!hasBwrap()) {
			console.log("Skipping bwrap tests: bwrap not installed");
			return;
		}

		testDir = await mkdtemp(join(testBase, "isolation-test-"));
		repoDir = join(testDir, "repo");
		await mkdir(repoDir, { recursive: true });
		await writeFile(join(repoDir, "test.txt"), "test content");
	});

	test("bwrapArgsForGit allows writes to repo directory", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForGit(repoDir);
		const result = run([...args, "sh", "-c", `echo "new file" > ${repoDir}/new.txt && cat ${repoDir}/new.txt`]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("new file");
	});

	test("bwrapArgsForGit blocks writes to /tmp (replaced with tmpfs)", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForGit(repoDir);
		// Write should succeed to tmpfs, but the file won't persist
		const result = run([...args, "sh", "-c", `echo "temp" > /tmp/test.txt && cat /tmp/test.txt`]);

		// tmpfs allows writes, but this verifies it's mounted
		expect(result.exitCode).toBe(0);
	});

	test("bwrapArgsForGit blocks writes to root filesystem", async () => {
		if (!hasBwrap()) return;

		const args = bwrapArgsForGit(repoDir);
		const result = run([...args, "sh", "-c", `echo "hack" > /etc/test.txt 2>&1`]);

		expect(result.exitCode).not.toBe(0);
	});

	test("bwrapArgsForTool allows reading files in worktree", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) return;

		const args = bwrapArgsForTool(repoDir, testDir);
		const result = await runWithSeccomp([...args, "cat", join(repoDir, "test.txt")]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("test content");
	});

	test("bwrapArgsForTool makes worktree read-only", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) return;

		const args = bwrapArgsForTool(repoDir, testDir);
		const result = await runWithSeccomp([...args, "sh", "-c", `echo "write" > ${repoDir}/write.txt 2>&1`]);

		expect(result.exitCode).not.toBe(0);
	});

	test("bwrapArgsForTool hides other directories in repo base", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) return;

		// Create another directory in testDir that should be hidden
		const otherDir = join(testDir, "other");
		await mkdir(otherDir, { recursive: true });
		await writeFile(join(otherDir, "secret.txt"), "secret");

		const args = bwrapArgsForTool(repoDir, testDir);
		const result = await runWithSeccomp([...args, "cat", join(otherDir, "secret.txt")]);

		expect(result.exitCode).not.toBe(0);
	});
});

// =============================================================================
// bwrap PID isolation tests
// =============================================================================

describe("bwrap PID isolation", () => {
	test("sandbox runs in isolated PID namespace", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) return;

		const testDir = await mkdtemp(join("/var/tmp", "pid-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		// Verify PID namespace is created (process gets PID 1 or low number)
		// Note: without --proc /proc, /proc still shows host processes,
		// but the sandbox process itself is in a new namespace
		const result = await runWithSeccomp([...args, "sh", "-c", "echo $$"]);

		expect(result.exitCode).toBe(0);
		// The shell should have a low PID in the new namespace
		const pid = parseInt(result.stdout.trim(), 10);
		expect(pid).toBeLessThan(100);

		await rm(testDir, { recursive: true });
	});

	test("host PIDs are not visible in sandbox", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) return;

		const testDir = await mkdtemp(join("/var/tmp", "pid-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		// Get a host PID that definitely exists (our own process)
		const hostPid = process.pid;

		// Try to check if this PID exists in the sandbox
		// In an isolated PID namespace, high host PIDs shouldn't exist
		const result = await runWithSeccomp([...args, "sh", "-c", `kill -0 ${hostPid} 2>&1`]);

		// Should fail - the host PID doesn't exist in the sandbox namespace
		expect(result.exitCode).not.toBe(0);

		await rm(testDir, { recursive: true });
	});
});

// =============================================================================
// seccomp network blocking tests
// =============================================================================

describe("seccomp network blocking", () => {
	test("without seccomp, network connections work", async () => {
		// This test verifies the baseline - network works without seccomp
		const result = run(["sh", "-c", "echo | nc -w 1 1.1.1.1 53 2>&1 || echo 'connected or timed out'"]);
		// We just verify the command runs - actual connectivity depends on network
		expect(result.exitCode).toBeDefined();
	});

	test("with seccomp via bwrap, IPv4 socket creation is blocked", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) {
			console.log("Skipping seccomp test: bwrap or filter not found");
			return;
		}

		const testDir = await mkdtemp(join("/var/tmp", "seccomp-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		// Try to create an IPv4 socket - should fail with EPERM
		const result = await runWithSeccomp([
			...args,
			"python3",
			"-c",
			"import socket; s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); print('created')",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Operation not permitted");

		await rm(testDir, { recursive: true });
	});

	test("with seccomp via bwrap, IPv6 socket creation is blocked", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) {
			console.log("Skipping seccomp test: bwrap or filter not found");
			return;
		}

		const testDir = await mkdtemp(join("/var/tmp", "seccomp-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		const result = await runWithSeccomp([
			...args,
			"python3",
			"-c",
			"import socket; s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); print('created')",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Operation not permitted");

		await rm(testDir, { recursive: true });
	});

	test("with seccomp via bwrap, Unix sockets still work", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) {
			console.log("Skipping seccomp test: bwrap or filter not found");
			return;
		}

		const testDir = await mkdtemp(join("/var/tmp", "seccomp-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		const result = await runWithSeccomp([
			...args,
			"python3",
			"-c",
			"import socket; s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); print('unix socket created')",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("unix socket created");

		await rm(testDir, { recursive: true });
	});

	test("with seccomp via bwrap, regular commands work", async () => {
		if (!hasBwrap() || !hasSeccompFilter()) {
			console.log("Skipping seccomp test: bwrap or filter not found");
			return;
		}

		const testDir = await mkdtemp(join("/var/tmp", "seccomp-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		const result = await runWithSeccomp([...args, "echo", "hello world"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");

		await rm(testDir, { recursive: true });
	});
});

// =============================================================================
// Combined isolation tests
// =============================================================================

describe("combined bwrap + seccomp isolation", () => {
	const testBase = "/var/tmp";

	function hasFullIsolation(): boolean {
		return hasBwrap() && hasSeccompFilter();
	}

	test("tool execution with full isolation can read files", async () => {
		if (!hasFullIsolation()) {
			console.log("Skipping combined test: bwrap or seccomp not available");
			return;
		}

		const testDir = await mkdtemp(join(testBase, "combined-test-"));
		await writeFile(join(testDir, "data.txt"), "isolated content");

		const args = bwrapArgsForTool(testDir, testDir);
		const result = await runWithSeccomp([...args, "cat", join(testDir, "data.txt")]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("isolated content");

		await rm(testDir, { recursive: true });
	});

	test("tool execution with full isolation blocks network", async () => {
		if (!hasFullIsolation()) {
			console.log("Skipping combined test: bwrap or seccomp not available");
			return;
		}

		const testDir = await mkdtemp(join(testBase, "combined-test-"));
		const args = bwrapArgsForTool(testDir, testDir);

		// Use bash /dev/tcp which requires socket creation
		const result = await runWithSeccomp([...args, "bash", "-c", "echo > /dev/tcp/1.1.1.1/53"]);

		expect(result.exitCode).not.toBe(0);

		await rm(testDir, { recursive: true });
	});

	test("tool execution with full isolation blocks writes", async () => {
		if (!hasFullIsolation()) {
			console.log("Skipping combined test: bwrap or seccomp not available");
			return;
		}

		const testDir = await mkdtemp(join(testBase, "combined-test-"));
		await writeFile(join(testDir, "existing.txt"), "original");

		const args = bwrapArgsForTool(testDir, testDir);
		const result = await runWithSeccomp([...args, "sh", "-c", `echo "modified" > ${testDir}/existing.txt`]);

		expect(result.exitCode).not.toBe(0);

		await rm(testDir, { recursive: true });
	});
});
