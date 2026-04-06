import type { Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { buildToolCommand } from "./tool-commands";

/** External binaries that must be installed for local (non-sandbox) execution. */
const REQUIRED_BINARIES = ["rg", "fd"] as const;

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

/**
 * Check that all required external tools are installed.
 * Returns an empty array if everything is available, otherwise returns the names of missing tools.
 */
export async function validateRequiredTools(): Promise<string[]> {
	const checks = await Promise.all(REQUIRED_BINARIES.map(async (bin) => ({ bin, available: await isAvailable(bin) })));
	return checks.filter((c) => !c.available).map((c) => c.bin);
}

// ---------------------------------------------------------------------------
// Tool definitions (LLM-facing schema)
// ---------------------------------------------------------------------------

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
				[
					Type.Literal("log"),
					Type.Literal("show"),
					Type.Literal("blame"),
					Type.Literal("diff"),
					Type.Literal("shortlog"),
					Type.Literal("describe"),
					Type.Literal("rev-parse"),
					Type.Literal("ls-tree"),
					Type.Literal("cat-file"),
				],
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

// ---------------------------------------------------------------------------
// Local execution
// ---------------------------------------------------------------------------

async function runCommand(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		return `Error (exit ${exitCode}):\n${stderr}`;
	}
	return stdout || "(no output)";
}

export async function executeTool(toolName: string, args: Record<string, unknown>, repoPath: string): Promise<string> {
	const toolCmd = buildToolCommand(toolName, args, repoPath);
	if (!toolCmd.ok) return toolCmd.error;

	const output = await runCommand(toolCmd.cmd, repoPath);
	return toolCmd.postProcess ? toolCmd.postProcess(output) : output;
}
