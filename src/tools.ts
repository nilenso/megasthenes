import { isAbsolute, relative, resolve } from "node:path";
import type { Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const RG_MAX_MATCHES_PER_FILE = 50;

/** Result of running a subprocess command. */
export interface CommandResult {
	output: string;
	exitCode: number;
}

/** Function signature for running a subprocess command. */
export type CommandRunner = (cmd: string[], cwd: string) => Promise<CommandResult>;

/** Allowed read-only git subcommands, shared with the sandbox worker. */
const ALLOWED_GIT_COMMANDS_LIST = [
	"log",
	"show",
	"blame",
	"diff",
	"shortlog",
	"describe",
	"rev-parse",
	"ls-tree",
	"cat-file",
] as const;
export const ALLOWED_GIT_COMMANDS: ReadonlySet<string> = new Set(ALLOWED_GIT_COMMANDS_LIST);

// ---------------------------------------------------------------------------
// Tool availability detection
// ---------------------------------------------------------------------------

const toolAvailabilityCache = new Map<string, boolean>();

async function isAvailable(bin: string): Promise<boolean> {
	const cached = toolAvailabilityCache.get(bin);
	if (cached !== undefined) return cached;

	try {
		const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		const available = exitCode === 0;
		toolAvailabilityCache.set(bin, available);
		return available;
	} catch {
		toolAvailabilityCache.set(bin, false);
		return false;
	}
}

/** Override tool availability for testing. */
export function overrideToolAvailability(bin: string, available: boolean): void {
	toolAvailabilityCache.set(bin, available);
}

export const tools: Tool[] = [
	{
		name: "rg",
		description:
			"Search for a pattern in files using ripgrep. Defaults to respecting .gitignore and hidden/binary files. Supports relevance filters and output limits.",
		parameters: Type.Object({
			pattern: Type.String({ description: "The regex pattern to search for" }),
			glob: Type.Optional(
				Type.String({
					description: "File glob pattern to filter files (e.g., '*.ts', '**/*.json')",
				}),
			),
			max_count: Type.Optional(Type.Number({ description: "Max matching lines per file" })),
			max_results: Type.Optional(
				Type.Number({
					description: "Max total matches (global), enforced via head",
				}),
			),
			word: Type.Optional(Type.Boolean({ description: "Match whole words only (-w)" })),
		}),
	},
	{
		name: "fd",
		description:
			"Find files by name pattern using fd. Returns matching file paths. Defaults to respecting .gitignore and excluding hidden files. Supports relevant filters and output limits.",
		parameters: Type.Object({
			pattern: Type.String({
				description: "The regex pattern to match file names against (use --glob for glob patterns)",
			}),
			type: Type.Optional(
				Type.Union([Type.Literal("f"), Type.Literal("d"), Type.Literal("l"), Type.Literal("x")], {
					description: "Filter by type: 'f' for files, 'd' for directories, 'l' for symlinks, 'x' for executables",
				}),
			),
			extension: Type.Optional(
				Type.String({
					description: "Filter by file extension (e.g., 'ts', 'json'). Can be comma-separated for multiple extensions.",
				}),
			),
			max_depth: Type.Optional(Type.Number({ description: "Maximum directory depth to search" })),
			max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
			hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories" })),
			glob: Type.Optional(Type.Boolean({ description: "Use glob pattern instead of regex" })),
			exclude: Type.Optional(
				Type.String({
					description: "Exclude entries matching this glob pattern (e.g., 'node_modules' or '*.pyc')",
				}),
			),
			full_path: Type.Optional(
				Type.Boolean({
					description: "Match pattern against full path, not just filename",
				}),
			),
		}),
	},
	{
		name: "ls",
		description: "List files and directories in a given path.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "Path to list, relative to repository root. Defaults to root if not specified.",
				}),
			),
		}),
	},
	{
		name: "read",
		description: "Read the entire contents of a file. Each line is prefixed with its line number.",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file, relative to repository root",
			}),
		}),
	},
	{
		name: "git",
		description:
			"Run read-only git commands to explore repository history. Allowed subcommands: log, show, blame, diff, shortlog, describe, rev-parse, ls-tree, cat-file.",
		parameters: Type.Object({
			command: Type.Union(
				ALLOWED_GIT_COMMANDS_LIST.map((cmd) => Type.Literal(cmd)),
				{ description: "The git subcommand to run" },
			),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Additional arguments for the git command (e.g., ['--oneline', '-n', '10'] for log, or ['HEAD~5..HEAD'] for diff)",
				}),
			),
		}),
	},
];

async function runCommand(cmd: string[], cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return { output: `Error (exit ${exitCode}):\n${stderr}`, exitCode };
	}
	return { output: stdout || "(no output)", exitCode: 0 };
}

/** Format a CommandResult as a plain string (for callers that don't need structured results). */
function resultToString(result: CommandResult): string {
	return result.output;
}

function validateProjectPath(repoPath: string, userPath: string): string | null {
	const repoRoot = resolve(repoPath);
	const fullPath = resolve(repoRoot, userPath);
	const relPath = relative(repoRoot, fullPath);

	if (relPath.startsWith("..") || isAbsolute(relPath)) {
		return null;
	}

	return fullPath;
}

// ---------------------------------------------------------------------------
// Command builders — rg / grep
// ---------------------------------------------------------------------------

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

export function buildGrepCommand(args: Record<string, unknown>): string[] {
	const pattern = args.pattern as string;
	const glob = args.glob as string | undefined;
	const maxCount = (args.max_count as number | undefined) ?? RG_MAX_MATCHES_PER_FILE;
	const word = args.word as boolean | undefined;

	const cmd = ["grep", "-rn", "-I", "-m", String(maxCount)];
	if (glob) cmd.push(`--include=${glob}`);
	if (word) cmd.push("-w");
	cmd.push(pattern, ".");
	return cmd;
}

async function executeRg(args: Record<string, unknown>, repoPath: string, runner: CommandRunner): Promise<string> {
	const maxResults = args.max_results as number | undefined;
	const rgAvailable = await isAvailable("rg");
	const cmd = rgAvailable ? buildRgCommand(args) : buildGrepCommand(args);

	const result = await runner(cmd, repoPath);

	if (maxResults && result.exitCode === 0) {
		const lines = result.output.split("\n").filter((l) => l.trim().length > 0);
		return lines.slice(0, maxResults).join("\n");
	}

	return resultToString(result);
}

// ---------------------------------------------------------------------------
// Command builders — fd / find
// ---------------------------------------------------------------------------

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

export function buildFindCommand(args: Record<string, unknown>): string[] {
	const pattern = args.pattern as string;
	const type = args.type as "f" | "d" | "l" | "x" | undefined;
	const extension = args.extension as string | undefined;
	const maxDepth = args.max_depth as number | undefined;
	const hidden = args.hidden as boolean | undefined;
	const glob = args.glob as boolean | undefined;
	const exclude = args.exclude as string | undefined;
	const fullPath = args.full_path as boolean | undefined;

	const cmd = ["find", "."];

	// maxdepth must come before other predicates in find
	if (maxDepth !== undefined) cmd.push("-maxdepth", String(maxDepth));

	// Exclude hidden files by default (fd behavior)
	if (!hidden) cmd.push("-not", "-path", "*/.*");

	// Exclude pattern
	if (exclude) cmd.push("-not", "-path", `*/${exclude}/*`);

	// Type filter
	if (type === "x") {
		cmd.push("-type", "f", "-perm", "+111");
	} else if (type) {
		cmd.push("-type", type);
	}

	// Extension filter (takes precedence over pattern matching)
	if (extension) {
		const exts = extension.split(",").map((e) => e.trim());
		if (exts.length === 1) {
			cmd.push("-name", `*.${exts[0]}`);
		} else {
			cmd.push("(");
			for (let i = 0; i < exts.length; i++) {
				if (i > 0) cmd.push("-o");
				cmd.push("-name", `*.${exts[i]}`);
			}
			cmd.push(")");
		}
	} else if (fullPath) {
		// Match pattern against full path
		cmd.push("-path", `*${pattern}*`);
	} else if (glob) {
		// Glob mode: use pattern as-is
		cmd.push("-name", pattern);
	} else {
		// Default: glob approximation of regex
		cmd.push("-name", `*${pattern}*`);
	}

	return cmd;
}

/** Strip ./ prefix from find output lines for consistency with fd. */
function stripFindPrefix(output: string): string {
	return output
		.split("\n")
		.map((line) => (line.startsWith("./") ? line.slice(2) : line))
		.filter((line) => line.trim().length > 0 && line !== ".")
		.join("\n");
}

async function executeFd(args: Record<string, unknown>, repoPath: string, runner: CommandRunner): Promise<string> {
	const maxResults = args.max_results as number | undefined;
	const fdAvailable = await isAvailable("fd");
	const cmd = fdAvailable ? buildFdCommand(args) : buildFindCommand(args);

	const result = await runner(cmd, repoPath);

	if (result.exitCode !== 0) return resultToString(result);

	if (!fdAvailable) {
		const stripped = stripFindPrefix(result.output);
		if (maxResults) {
			const lines = stripped.split("\n").filter((l) => l.trim().length > 0);
			return lines.slice(0, maxResults).join("\n") || "(no output)";
		}
		return stripped || "(no output)";
	}

	return resultToString(result);
}

async function executeLs(args: Record<string, unknown>, repoPath: string, runner: CommandRunner): Promise<string> {
	const path = (args.path as string | undefined) || ".";
	const fullPath = validateProjectPath(repoPath, path);
	if (!fullPath) {
		return `Error: invalid project path: ${path}`;
	}

	return resultToString(await runner(["ls", "-la", fullPath], repoPath));
}

async function executeRead(args: Record<string, unknown>, repoPath: string, runner: CommandRunner): Promise<string> {
	const filePath = args.path as string;
	const fullPath = validateProjectPath(repoPath, filePath);
	if (!fullPath) {
		return `Error: invalid project path: ${filePath}`;
	}

	const result = await runner(["cat", "-n", fullPath], repoPath);
	if (result.exitCode !== 0) {
		return resultToString(result);
	}
	return `[File: ${filePath}]\n\n${result.output}`;
}

async function executeGit(args: Record<string, unknown>, repoPath: string, runner: CommandRunner): Promise<string> {
	const command = args.command as string;
	if (!ALLOWED_GIT_COMMANDS.has(command)) {
		return `Error: git subcommand not allowed: ${command}. Allowed: ${[...ALLOWED_GIT_COMMANDS].join(", ")}`;
	}
	const gitArgs = (args.args as string[]) || [];

	const cmd = ["git", command, ...gitArgs];
	return resultToString(await runner(cmd, repoPath));
}

export async function executeTool(
	toolName: string,
	args: Record<string, unknown>,
	repoPath: string,
	runner: CommandRunner = runCommand,
): Promise<string> {
	switch (toolName) {
		case "rg":
			return executeRg(args, repoPath, runner);
		case "fd":
			return executeFd(args, repoPath, runner);
		case "ls":
			return executeLs(args, repoPath, runner);
		case "read":
			return executeRead(args, repoPath, runner);
		case "git":
			return executeGit(args, repoPath, runner);
		default:
			return `Unknown tool: ${toolName}`;
	}
}
