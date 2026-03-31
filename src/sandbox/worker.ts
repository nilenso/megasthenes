/**
 * Sandbox worker — HTTP server for isolated git and tool operations.
 *
 * Endpoints:
 *   POST /clone          { url, commitish? }  → start cloning a repo (async)
 *   GET  /clone/status/:slug?commitish=       → poll clone status
 *   POST /tool           { slug, sha, name, args }  → execute a tool
 *   GET  /health                              → liveness check
 *   POST /reset                               → delete all cloned data
 *
 * Security is provided by the isolation module (see ./isolation/).
 */

import { closeSync, openSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isolatedGitCommand, isolatedGitToolCommand, isolatedToolCommand } from "./isolation";

/** Path to seccomp BPF filter that blocks network sockets (arch-specific) */
const SECCOMP_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const SECCOMP_FILTER_PATH = `/etc/seccomp/${SECCOMP_ARCH}/net-block.bpf`;

const PORT = Number(process.env.PORT) || 8080;
const REPO_BASE = "/home/forge/repos";
const SANDBOX_SECRET = process.env.SANDBOX_SECRET || "";

// =============================================================================
// Helpers
// =============================================================================

// Git environment to prevent interactive prompts
const GIT_ENV: Record<string, string> = {
	SSH_AUTH_SOCK: "",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/home/forge",
};

/** Default timeout for tool execution (30 seconds) */
const TOOL_TIMEOUT_MS = 30_000;
/** Default timeout for git clone operations (20 minutes) */
const CLONE_TIMEOUT_MS = 20 * 60 * 1000;
/** Default timeout for non-clone git operations (120 seconds) */
const GIT_TIMEOUT_MS = 120_000;

/** Shorten a command array for logging (avoid dumping huge bwrap arg lists). */
function summarizeCmd(cmd: string[]): string {
	// Find the index after "--" (end of bwrap args) to show the actual command
	const dashDash = cmd.indexOf("--");
	if (dashDash !== -1 && dashDash < cmd.length - 1) {
		return `bwrap -- ${cmd.slice(dashDash + 1).join(" ")}`;
	}
	return cmd.join(" ");
}

async function run(
	cmd: string[],
	cwd?: string,
	env?: Record<string, string>,
	timeoutMs?: number,
	seccompFilterPath?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const t0 = Date.now();
	const cmdSummary = summarizeCmd(cmd);
	console.debug(`[sandbox:run] exec: ${cmdSummary} cwd=${cwd ?? "(none)"}`);

	// If seccomp filter is specified, open it and pass as FD 3
	let seccompFd: number | undefined;
	let stdio: ["pipe", "pipe", "pipe"] | ["pipe", "pipe", "pipe", number] = ["pipe", "pipe", "pipe"];
	if (seccompFilterPath) {
		seccompFd = openSync(seccompFilterPath, "r");
		stdio = ["pipe", "pipe", "pipe", seccompFd];
	}

	const proc = Bun.spawn(cmd, {
		cwd,
		stdio,
		env: env ?? process.env,
	});

	try {
		if (timeoutMs) {
			const timer = setTimeout(() => {
				try {
					proc.kill();
				} catch {
					/* already exited */
				}
			}, timeoutMs);

			const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const exitCode = await proc.exited;
			clearTimeout(timer);

			if (exitCode === 137 || exitCode === -1) {
				const duration = Date.now() - t0;
				console.error(`[sandbox:run] timeout after ${duration}ms: ${cmdSummary}`);
				return { stdout, stderr: `${stderr}\nOperation timed out after ${timeoutMs}ms`, exitCode: 124 };
			}

			const duration = Date.now() - t0;
			if (exitCode !== 0) {
				console.warn(`[sandbox:run] exit=${exitCode} (${duration}ms): ${cmdSummary} stderr=${stderr.slice(0, 200)}`);
			} else {
				console.debug(`[sandbox:run] exit=0 (${duration}ms): ${cmdSummary}`);
			}
			return { stdout, stderr, exitCode };
		}

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;

		const duration = Date.now() - t0;
		if (exitCode !== 0) {
			console.warn(`[sandbox:run] exit=${exitCode} (${duration}ms): ${cmdSummary} stderr=${stderr.slice(0, 200)}`);
		} else {
			console.debug(`[sandbox:run] exit=0 (${duration}ms): ${cmdSummary}`);
		}
		return { stdout, stderr, exitCode };
	} finally {
		if (seccompFd !== undefined) {
			closeSync(seccompFd);
		}
	}
}

function repoDir(id: string): string {
	return `${REPO_BASE}/${id}`;
}

/** Turn a repo URL into a safe filesystem slug. */
function slugify(url: string): string {
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname}`.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
	} catch {
		return url.replace(/[^a-zA-Z0-9._-]/g, "_");
	}
}

/** Validate path stays within worktree root. */
function validatePath(worktree: string, userPath: string): string | null {
	const worktreeRoot = resolve(worktree);
	const fullPath = resolve(worktreeRoot, userPath);
	const relPath = relative(worktreeRoot, fullPath);

	if (relPath.startsWith("..") || isAbsolute(relPath)) {
		return null;
	}

	return fullPath;
}

/** Run a git command with filesystem + PID isolation. */
async function runGitIsolated(
	gitArgs: string[],
	cwd: string | undefined,
	repoBaseDir: string,
	timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return run(
		isolatedGitCommand(gitArgs, repoBaseDir),
		cwd,
		{ ...GIT_ENV, GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1" },
		timeoutMs,
	);
}

/** Run a tool command with filesystem, PID, and network isolation. */
async function runToolIsolated(
	cmd: string[],
	worktree: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return run(isolatedToolCommand(cmd, worktree, REPO_BASE), worktree, undefined, TOOL_TIMEOUT_MS, SECCOMP_FILTER_PATH);
}

// =============================================================================
// Async Clone State
// =============================================================================

type CloneStatus = "cloning" | "ready" | "failed";

interface CloneJob {
	status: CloneStatus;
	url: string;
	slug: string;
	/** Set when status = "ready" */
	sha?: string;
	worktree?: string;
	/** Set when status = "failed" */
	error?: string;
	startedAt: number;
	finishedAt?: number;
}

/**
 * In-memory clone job tracker.
 * Key: `${slug}:${commitish}` — one job per repo+commitish combination.
 * If a clone is already in progress for the same slug+commitish, new requests
 * get the existing job (deduplication).
 */
const cloneJobs = new Map<string, CloneJob>();

/** Clean up finished jobs older than 10 minutes. */
const JOB_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
	const now = Date.now();
	for (const [key, job] of cloneJobs) {
		if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
			cloneJobs.delete(key);
		}
	}
}, 60_000);

// =============================================================================
// Clone (async)
// =============================================================================

interface CloneRequest {
	url: string;
	commitish?: string;
}

/** Translate raw git clone stderr into a user-friendly error message. */
function friendlyCloneError(stderr: string, url: string): string {
	const s = stderr.toLowerCase();
	if (s.includes("could not read username") || s.includes("terminal prompts disabled")) {
		return `Repository not found or is private: ${url}. Only public repositories are supported.`;
	}
	if (s.includes("repository not found") || s.includes("not found")) {
		return `Repository not found: ${url}. Check that the URL is correct and the repository exists.`;
	}
	if (s.includes("could not resolve host")) {
		return `Could not reach the git host. Check that the URL is correct.`;
	}
	if (s.includes("timed out") || s.includes("operation timed out")) {
		return `Clone timed out for ${url}. The repository may be too large or the server is unreachable.`;
	}
	// Fallback: return a trimmed version of stderr
	return `Clone failed for ${url}: ${stderr.slice(0, 300).trim()}`;
}

/**
 * Execute the clone/fetch + worktree setup in the background.
 * Updates the job entry in cloneJobs as it progresses.
 */
async function executeClone(jobKey: string, url: string, commitish: string): Promise<void> {
	const job = cloneJobs.get(jobKey);
	if (!job) return;

	const slug = job.slug;
	const baseDir = repoDir(slug);
	const bareDir = `${baseDir}/bare`;
	const treesDir = `${baseDir}/trees`;

	try {
		// Ensure directories exist
		await Bun.spawn(["mkdir", "-p", bareDir, treesDir]).exited;

		// Clone or fetch
		const headFile = Bun.file(`${bareDir}/HEAD`);
		if (await headFile.exists()) {
			const { exitCode, stderr } = await runGitIsolated(["fetch", "origin", "--tags"], bareDir, baseDir);
			if (exitCode !== 0) {
				console.error(`[sandbox:clone] fetch failed: ${stderr}`);
			}
		} else {
			const { exitCode, stderr } = await runGitIsolated(
				["clone", "--bare", url, bareDir],
				undefined,
				baseDir,
				CLONE_TIMEOUT_MS,
			);
			if (exitCode !== 0) {
				job.status = "failed";
				job.error = friendlyCloneError(stderr, url);
				job.finishedAt = Date.now();
				console.error(`[sandbox:clone] clone failed for ${url}: ${stderr.slice(0, 200)}`);
				return;
			}
		}

		// Resolve commitish → SHA
		const revParse = await runGitIsolated(["rev-parse", commitish], bareDir, baseDir);
		if (revParse.exitCode !== 0) {
			job.status = "failed";
			job.error = `Cannot resolve commitish "${commitish}": ${revParse.stderr.slice(0, 300)}`;
			job.finishedAt = Date.now();
			return;
		}
		const sha = revParse.stdout.trim();
		const shortSha = sha.slice(0, 12);
		const worktree = `${treesDir}/${shortSha}`;

		// Create worktree if it doesn't exist
		const worktreeExists = await Bun.file(`${worktree}/.git`).exists();
		if (!worktreeExists) {
			const wt = await runGitIsolated(["worktree", "add", worktree, sha], bareDir, baseDir);
			if (wt.exitCode !== 0) {
				job.status = "failed";
				job.error = `git worktree add failed: ${wt.stderr.slice(0, 300)}`;
				job.finishedAt = Date.now();
				return;
			}
		}

		job.status = "ready";
		job.sha = sha;
		job.worktree = worktree;
		job.finishedAt = Date.now();
		console.info(`[sandbox:clone] ready: ${url} → ${slug} @ ${shortSha} (${Date.now() - job.startedAt}ms)`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		job.status = "failed";
		job.error = msg;
		job.finishedAt = Date.now();
		console.error(`[sandbox:clone] exception for ${url}: ${msg}`);
	}
}

/**
 * POST /clone — kick off a clone in the background.
 * Returns immediately with { ok, status: "cloning"|"ready", slug }.
 * If the repo is already cloned, returns "ready" immediately.
 * If a clone is already in progress, returns "cloning" (dedup).
 */
function handleClone(body: CloneRequest): Response {
	const { url, commitish = "HEAD" } = body;
	if (!url) {
		return Response.json({ ok: false, error: "url is required" }, { status: 400 });
	}

	const slug = slugify(url);
	const jobKey = `${slug}:${commitish}`;

	// Check for existing job
	const existing = cloneJobs.get(jobKey);
	if (existing) {
		if (existing.status === "ready") {
			return Response.json({
				ok: true,
				status: "ready",
				slug,
				sha: existing.sha,
				worktree: existing.worktree,
			});
		}
		if (existing.status === "cloning") {
			return Response.json({ ok: true, status: "cloning", slug });
		}
		// "failed" — allow retry by falling through to create a new job
	}

	// Create new job
	const job: CloneJob = {
		status: "cloning",
		url,
		slug,
		startedAt: Date.now(),
	};
	cloneJobs.set(jobKey, job);

	// Fire and forget — clone runs in the background
	executeClone(jobKey, url, commitish);

	return Response.json({ ok: true, status: "cloning", slug });
}

/**
 * GET /clone/status/:slug?commitish=HEAD — poll clone progress.
 * Returns { ok, status: "cloning"|"ready"|"failed", ... }.
 */
function handleCloneStatus(slug: string, commitish: string): Response {
	const jobKey = `${slug}:${commitish}`;
	const job = cloneJobs.get(jobKey);

	if (!job) {
		return Response.json({ ok: false, error: "No clone job found for this repo" }, { status: 404 });
	}

	if (job.status === "ready") {
		return Response.json({
			ok: true,
			status: "ready",
			slug: job.slug,
			sha: job.sha,
			worktree: job.worktree,
		});
	}

	if (job.status === "failed") {
		return Response.json({
			ok: false,
			status: "failed",
			error: job.error,
		});
	}

	// Still cloning
	const elapsed = Date.now() - job.startedAt;
	return Response.json({
		ok: true,
		status: "cloning",
		slug: job.slug,
		elapsedMs: elapsed,
	});
}

// =============================================================================
// Tool execution
// =============================================================================

interface ToolRequest {
	slug: string;
	sha: string;
	name: string;
	args: Record<string, unknown>;
}

async function handleTool(body: ToolRequest): Promise<Response> {
	const { slug, sha, name, args } = body;
	if (!slug || !sha || !name) {
		return Response.json({ ok: false, error: "slug, sha, and name are required" }, { status: 400 });
	}

	const shortSha = sha.slice(0, 12);
	const worktree = `${repoDir(slug)}/trees/${shortSha}`;
	const wtExists = await Bun.file(`${worktree}/.git`).exists();
	if (!wtExists) {
		return Response.json({ ok: false, error: `Worktree not found: ${worktree}` }, { status: 404 });
	}

	switch (name) {
		case "rg": {
			const pattern = args.pattern as string;
			const glob = args.glob as string | undefined;
			const cmd = ["rg", "--line-number", pattern];
			if (glob) cmd.push("--glob", glob);
			const result = await runToolIsolated(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `rg failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "find": {
			const pattern = args.pattern as string;
			const type = args.type as "f" | "d" | undefined;
			const cmd = ["find", ".", "-name", `*${pattern}*`];
			if (type === "f") cmd.push("-type", "f");
			else if (type === "d") cmd.push("-type", "d");
			const result = await runToolIsolated(cmd, worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `find failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "ls": {
			const path = (args.path as string) || ".";
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: false, error: `invalid project path: ${path}` }, { status: 400 });
			}
			const result = await runToolIsolated(["ls", "-la", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `ls failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		case "read": {
			const path = args.path as string;
			const fullPath = validatePath(worktree, path);
			if (!fullPath) {
				return Response.json({ ok: false, error: `invalid project path: ${path}` }, { status: 400 });
			}
			const result = await runToolIsolated(["cat", "-n", fullPath], worktree);
			if (result.exitCode !== 0) {
				return Response.json(
					{ ok: false, error: `read failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(empty file)" });
		}
		case "git": {
			// Read-only git commands (log, show, blame, diff, etc.)
			const subcommand = args.command as string;
			const gitArgs = (args.args as string[]) || [];

			// Allowlist of read-only git subcommands
			const allowedCommands = [
				"log",
				"show",
				"blame",
				"diff",
				"shortlog",
				"describe",
				"rev-parse",
				"ls-tree",
				"cat-file",
			];
			if (!allowedCommands.includes(subcommand)) {
				return Response.json(
					{ ok: false, error: `git subcommand not allowed: ${subcommand}. Allowed: ${allowedCommands.join(", ")}` },
					{ status: 400 },
				);
			}

			// Validate any path arguments don't escape worktree
			for (const arg of gitArgs) {
				if (arg.startsWith("-")) continue; // Skip flags
				if (arg.includes("..")) {
					return Response.json({ ok: false, error: "path traversal not allowed in args" }, { status: 400 });
				}
			}

			// Git worktrees need access to bare repo for .git references
			const bareRepo = `${repoDir(slug)}/bare`;
			const cmd = isolatedGitToolCommand(["git", subcommand, ...gitArgs], worktree, bareRepo, REPO_BASE);
			const result = await run(cmd, worktree, undefined, TOOL_TIMEOUT_MS, SECCOMP_FILTER_PATH);
			if (result.exitCode !== 0 && result.stderr) {
				return Response.json(
					{ ok: false, error: `git ${subcommand} failed (exit ${result.exitCode}):\n${result.stderr}` },
					{ status: 500 },
				);
			}
			return Response.json({ ok: true, output: result.stdout || "(no output)" });
		}
		default:
			return Response.json({ ok: false, error: `Unknown tool: ${name}` }, { status: 400 });
	}
}

// =============================================================================
// Reset (delete all repos)
// =============================================================================

async function handleReset(): Promise<Response> {
	const { exitCode } = await run(["rm", "-rf", REPO_BASE]);
	if (exitCode !== 0) {
		return Response.json({ ok: false, error: "Failed to clean repos" }, { status: 500 });
	}
	await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;
	// Clear all clone job state
	cloneJobs.clear();
	return Response.json({ ok: true });
}

// =============================================================================
// HTTP Server
// =============================================================================

await Bun.spawn(["mkdir", "-p", REPO_BASE]).exited;

function checkAuth(req: Request): Response | null {
	if (!SANDBOX_SECRET) return null; // No secret configured = no auth required
	const token = req.headers.get("Authorization")?.replace("Bearer ", "");
	if (token !== SANDBOX_SECRET) {
		return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
	}
	return null;
}

/** Extract key params from request body for logging. */
function requestSummary(pathname: string, body: unknown): string {
	if (pathname === "/clone") {
		const b = body as Partial<CloneRequest>;
		return `url=${b.url ?? "?"} commitish=${b.commitish ?? "HEAD"}`;
	}
	if (pathname === "/tool") {
		const b = body as Partial<ToolRequest>;
		return `slug=${b.slug ?? "?"} sha=${(b.sha ?? "?").slice(0, 12)} name=${b.name ?? "?"}`;
	}
	return "";
}

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const { pathname } = url;

		// Health check is unauthenticated (needed for Docker healthcheck)
		if (pathname === "/health" && req.method === "GET") {
			return Response.json({ ok: true });
		}

		// All other endpoints require auth
		const authError = checkAuth(req);
		if (authError) return authError;

		const t0 = Date.now();
		let body: unknown;
		let response: Response;

		if (pathname === "/clone" && req.method === "POST") {
			body = await req.json();
			console.info(`[sandbox] ${req.method} ${pathname} ${requestSummary(pathname, body)}`);
			response = handleClone(body as CloneRequest);
		} else if (pathname.startsWith("/clone/status/") && req.method === "GET") {
			const slug = pathname.slice("/clone/status/".length);
			const commitish = url.searchParams.get("commitish") || "HEAD";
			response = handleCloneStatus(slug, commitish);
		} else if (pathname === "/tool" && req.method === "POST") {
			body = await req.json();
			console.info(`[sandbox] ${req.method} ${pathname} ${requestSummary(pathname, body)}`);
			response = await handleTool(body as ToolRequest);
		} else if (pathname === "/reset" && req.method === "POST") {
			console.info(`[sandbox] ${req.method} ${pathname}`);
			response = await handleReset();
		} else {
			return new Response("Not Found", { status: 404 });
		}

		const duration = Date.now() - t0;
		if (response.status >= 400) {
			console.warn(`[sandbox] ${req.method} ${pathname} → ${response.status} (${duration}ms)`);
		} else if (!pathname.startsWith("/clone/status/")) {
			// Don't log every poll request
			console.info(`[sandbox] ${req.method} ${pathname} → ${response.status} (${duration}ms)`);
		}
		return response;
	},
});

console.log(`[sandbox] listening on :${server.port}`);
