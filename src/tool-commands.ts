/**
 * Shared tool command builders.
 *
 * This module is the single source of truth for how tool arguments map to shell
 * commands. It has zero external dependencies so it can be deployed inside the
 * sandbox container alongside the worker.
 *
 * Both the local executor (tools.ts) and the sandbox worker (worker.ts) import
 * from here, ensuring consistent parameter handling everywhere.
 */

import { isAbsolute, relative, resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const RG_MAX_MATCHES_PER_FILE = 50;

export const ALLOWED_GIT_SUBCOMMANDS = [
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

// =============================================================================
// Types
// =============================================================================

/** Result of building a tool command — either a runnable command or a validation error. */
export type ToolCommand =
	| { ok: true; cmd: string[]; postProcess?: (stdout: string) => string }
	| { ok: false; error: string };

// =============================================================================
// Helpers
// =============================================================================

/** Validate that a user-supplied path stays within the given root directory. */
export function validateProjectPath(rootPath: string, userPath: string): string | null {
	const root = resolve(rootPath);
	const full = resolve(root, userPath);
	const rel = relative(root, full);

	if (rel.startsWith("..") || isAbsolute(rel)) {
		return null;
	}

	return full;
}

// =============================================================================
// Command Builders
// =============================================================================

export function buildRgCommand(args: Record<string, unknown>): string[] {
	const pattern = args.pattern as string;
	const glob = args.glob as string | undefined;
	const maxCount = (args.max_count as number | undefined) ?? RG_MAX_MATCHES_PER_FILE;
	const word = args.word as boolean | undefined;

	const cmd = ["rg", "--line-number", "--max-count", String(maxCount), pattern];
	if (glob) cmd.push("--glob", glob);
	if (word) cmd.push("-w");
	return cmd;
}

function buildRg(args: Record<string, unknown>): ToolCommand {
	const maxResults = args.max_results as number | undefined;
	const cmd = buildRgCommand(args);

	const postProcess = maxResults
		? (output: string) => {
				if (output.startsWith("Error")) return output;
				const lines = output.split("\n").filter((l) => l.trim().length > 0);
				return lines.slice(0, maxResults).join("\n");
			}
		: undefined;

	return { ok: true, cmd, postProcess };
}

export function buildFdCommand(args: Record<string, unknown>): string[] {
	const pattern = args.pattern as string;
	const type = args.type as "f" | "d" | "l" | "x" | undefined;
	const extension = args.extension as string | undefined;
	const maxDepth = args.max_depth as number | undefined;
	const maxResults = args.max_results as number | undefined;
	const hidden = args.hidden as boolean | undefined;
	const glob = args.glob as boolean | undefined;
	const exclude = args.exclude as string | undefined;
	const fullPath = args.full_path as boolean | undefined;

	const cmd = ["fd"];

	if (type) cmd.push("--type", type);
	if (hidden) cmd.push("--hidden");
	if (glob) cmd.push("--glob");
	if (fullPath) cmd.push("--full-path");
	if (maxDepth !== undefined) cmd.push("--max-depth", String(maxDepth));
	if (maxResults !== undefined) cmd.push("--max-results", String(maxResults));
	if (exclude) cmd.push("--exclude", exclude);

	if (extension) {
		for (const ext of extension.split(",").map((e) => e.trim())) {
			cmd.push("--extension", ext);
		}
	}

	cmd.push(pattern);
	return cmd;
}

function buildFd(args: Record<string, unknown>): ToolCommand {
	return { ok: true, cmd: buildFdCommand(args) };
}

function buildLs(args: Record<string, unknown>, cwd: string): ToolCommand {
	const path = (args.path as string | undefined) || ".";
	const fullPath = validateProjectPath(cwd, path);
	if (!fullPath) {
		return { ok: false, error: `Error: invalid project path: ${path}` };
	}
	return { ok: true, cmd: ["ls", "-la", fullPath] };
}

function buildRead(args: Record<string, unknown>, cwd: string): ToolCommand {
	const filePath = args.path as string;
	const fullPath = validateProjectPath(cwd, filePath);
	if (!fullPath) {
		return { ok: false, error: `Error: invalid project path: ${filePath}` };
	}
	return {
		ok: true,
		cmd: ["cat", "-n", fullPath],
		postProcess: (output) => {
			if (output.startsWith("Error")) return output;
			return `[File: ${filePath}]\n\n${output}`;
		},
	};
}

function buildGit(args: Record<string, unknown>): ToolCommand {
	const command = args.command as string;
	const gitArgs = (args.args as string[]) || [];

	if (!ALLOWED_GIT_SUBCOMMANDS.includes(command)) {
		return {
			ok: false,
			error: `git subcommand not allowed: ${command}. Allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(", ")}`,
		};
	}

	return { ok: true, cmd: ["git", command, ...gitArgs] };
}

// =============================================================================
// Router
// =============================================================================

/**
 * Build the shell command for a tool invocation.
 *
 * Returns a runnable command array plus optional post-processing,
 * or a validation error. The caller is responsible for actually
 * executing the command (locally via Bun.spawn, or in a sandbox via bwrap).
 */
export function buildToolCommand(name: string, args: Record<string, unknown>, cwd: string): ToolCommand {
	switch (name) {
		case "rg":
			return buildRg(args);
		case "fd":
			return buildFd(args);
		case "ls":
			return buildLs(args, cwd);
		case "read":
			return buildRead(args, cwd);
		case "git":
			return buildGit(args);
		default:
			return { ok: false, error: `Unknown tool: ${name}` };
	}
}
