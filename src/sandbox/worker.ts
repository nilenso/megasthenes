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
import { buildToolCommand } from "../tool-commands";
import type { ErrorType } from "../types";
import { isolatedGitCommand, isolatedGitToolCommand, isolatedToolCommand } from "./isolation";
import { type CloneRequest, type ToolRequest, validateCloneRequest, validateToolRequest } from "./request-schemas";

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
	// stdin is /dev/null — no spawned command needs interactive input.
	// Using "pipe" would cause rg (and similar) to block reading stdin forever.
	let stdio: ["ignore", "pipe", "pipe"] | ["ignore", "pipe", "pipe", number] = ["ignore", "pipe", "pipe"];
	if (seccompFilterPath) {
		seccompFd = openSync(seccompFilterPath, "r");
		stdio = ["ignore", "pipe", "pipe", seccompFd];
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

interface CloneJobBase {
	url: string;
	slug: string;
	startedAt: number;
}

type CloneJob =
	| (CloneJobBase & { status: "cloning" })
	| (CloneJobBase & { status: "ready"; sha: string; worktree: string; finishedAt: number })
	| (CloneJobBase & { status: "failed"; error: string; errorType: ErrorType; finishedAt: number });

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
		if (job.status !== "cloning" && now - job.finishedAt > JOB_TTL_MS) {
			cloneJobs.delete(key);
		}
	}
}, 60_000);

// =============================================================================
// Clone (async)
// =============================================================================

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
 * Replaces the job entry in cloneJobs as it transitions between states.
 */
async function executeClone(jobKey: string, url: string, commitish: string): Promise<void> {
	const started = cloneJobs.get(jobKey);
	if (!started) return;
	const base: CloneJobBase = { url: started.url, slug: started.slug, startedAt: started.startedAt };

	const markFailed = (error: string, errorType: ErrorType): void => {
		cloneJobs.set(jobKey, { ...base, status: "failed", error, errorType, finishedAt: Date.now() });
	};

	const baseDir = repoDir(base.slug);
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
				["clone", "--bare", "--filter=blob:none", url, bareDir],
				undefined,
				baseDir,
				CLONE_TIMEOUT_MS,
			);
			if (exitCode !== 0) {
				console.error(`[sandbox:clone] clone failed for ${url}: ${stderr.slice(0, 200)}`);
				markFailed(friendlyCloneError(stderr, url), "clone_failed");
				return;
			}
		}

		// Resolve commitish → SHA
		const revParse = await runGitIsolated(["rev-parse", commitish], bareDir, baseDir);
		if (revParse.exitCode !== 0) {
			markFailed(`Cannot resolve commitish "${commitish}": ${revParse.stderr.slice(0, 300)}`, "invalid_commitish");
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
				markFailed(`git worktree add failed: ${wt.stderr.slice(0, 300)}`, "clone_failed");
				return;
			}
		}

		cloneJobs.set(jobKey, { ...base, status: "ready", sha, worktree, finishedAt: Date.now() });
		console.info(`[sandbox:clone] ready: ${url} → ${base.slug} @ ${shortSha} (${Date.now() - base.startedAt}ms)`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		markFailed(msg, "clone_failed");
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
	// `body` is already schema-validated at the HTTP boundary — `url` is
	// guaranteed to be a non-empty string, so no per-field nil checks here.
	const { url, commitish = "HEAD" } = body;

	const slug = slugify(url);
	const jobKey = `${slug}:${commitish}`;

	// Check for existing job
	const existing = cloneJobs.get(jobKey);
	if (existing) {
		switch (existing.status) {
			case "ready":
				return Response.json({
					ok: true,
					status: "ready",
					slug,
					sha: existing.sha,
					worktree: existing.worktree,
				});
			case "cloning":
				return Response.json({ ok: true, status: "cloning", slug });
			case "failed":
				// allow retry by falling through to create a new job
				break;
		}
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

	switch (job.status) {
		case "ready":
			return Response.json({
				ok: true,
				status: "ready",
				slug: job.slug,
				sha: job.sha,
				worktree: job.worktree,
			});
		case "failed":
			return Response.json({
				ok: false,
				status: "failed",
				error: job.error,
				errorType: job.errorType,
			});
		case "cloning":
			return Response.json({
				ok: true,
				status: "cloning",
				slug: job.slug,
				elapsedMs: Date.now() - job.startedAt,
			});
	}
}

// =============================================================================
// Tool execution
// =============================================================================

async function handleTool(body: ToolRequest): Promise<Response> {
	// `body` is already schema-validated at the HTTP boundary — required string
	// fields are guaranteed present and non-empty. Per-tool arg validation still
	// happens downstream in `buildToolCommand`.
	const { slug, sha, name, args } = body;

	const shortSha = sha.slice(0, 12);
	const worktree = `${repoDir(slug)}/trees/${shortSha}`;
	const wtExists = await Bun.file(`${worktree}/.git`).exists();
	if (!wtExists) {
		return Response.json({ ok: false, error: `Worktree not found: ${worktree}` }, { status: 404 });
	}

	const toolCmd = buildToolCommand(name, args, worktree);
	if (!toolCmd.ok) {
		return Response.json({ ok: false, error: toolCmd.error }, { status: 400 });
	}

	// Git needs access to the bare repo for worktree .git references
	let result: { stdout: string; stderr: string; exitCode: number };
	if (name === "git") {
		const bareRepo = `${repoDir(slug)}/bare`;
		const cmd = isolatedGitToolCommand(toolCmd.cmd, worktree, bareRepo, REPO_BASE);
		result = await run(cmd, worktree, undefined, TOOL_TIMEOUT_MS, SECCOMP_FILTER_PATH);
	} else {
		result = await runToolIsolated(toolCmd.cmd, worktree);
	}

	if (result.exitCode !== 0) {
		return Response.json(
			{ ok: false, error: `${name} failed (exit ${result.exitCode}):\n${result.stderr}` },
			{ status: 500 },
		);
	}

	const output = result.stdout || "(no output)";
	return Response.json({ ok: true, output: toolCmd.postProcess ? toolCmd.postProcess(output) : output });
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

/**
 * Parse a request body as JSON, returning a discriminated result.
 *
 * `req.json()` throws `SyntaxError` on malformed JSON; letting that bubble up
 * would produce an opaque 500. Catching it here keeps the failure mode at
 * the boundary: bad JSON → 400 Bad Request with a clear message.
 */
async function parseJsonBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	try {
		return { ok: true, value: await req.json() };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Malformed JSON body: ${msg}` };
	}
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
			const parsed = await parseJsonBody(req);
			if (!parsed.ok) {
				response = Response.json({ ok: false, error: parsed.error }, { status: 400 });
			} else {
				body = parsed.value;
				console.info(`[sandbox] ${req.method} ${pathname} ${requestSummary(pathname, body)}`);
				// Validate untrusted input at the boundary. A cast is not validation —
				// malformed payloads must be rejected here so downstream helpers only
				// ever see well-formed `CloneRequest` values.
				const validated = validateCloneRequest(body);
				if (!validated.ok) {
					response = Response.json({ ok: false, error: `Invalid clone request: ${validated.error}` }, { status: 400 });
				} else {
					response = handleClone(validated.value);
				}
			}
		} else if (pathname.startsWith("/clone/status/") && req.method === "GET") {
			const slug = pathname.slice("/clone/status/".length);
			const commitish = url.searchParams.get("commitish") || "HEAD";
			response = handleCloneStatus(slug, commitish);
		} else if (pathname === "/tool" && req.method === "POST") {
			const parsed = await parseJsonBody(req);
			if (!parsed.ok) {
				response = Response.json({ ok: false, error: parsed.error }, { status: 400 });
			} else {
				body = parsed.value;
				console.info(`[sandbox] ${req.method} ${pathname} ${requestSummary(pathname, body)}`);
				const validated = validateToolRequest(body);
				if (!validated.ok) {
					response = Response.json({ ok: false, error: `Invalid tool request: ${validated.error}` }, { status: 400 });
				} else {
					response = await handleTool(validated.value);
				}
			}
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
