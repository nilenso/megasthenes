import type { Tool } from "@mariozechner/pi-ai";
import { buildToolCommand, fdSchema, gitSchema, lsSchema, readSchema, rgSchema } from "./tool-commands";

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
// Tool definitions (LLM-facing catalog)
// ---------------------------------------------------------------------------

export const tools: Tool[] = [
	{
		name: "rg",
		description:
			"Search for a pattern in files using ripgrep. Defaults to respecting .gitignore and hidden/binary files. Supports relevance filters and output limits.",
		parameters: rgSchema,
	},
	{
		name: "fd",
		description:
			"Find files by name pattern using fd. Returns matching file paths. Defaults to respecting .gitignore and excluding hidden files. Supports relevant filters and output limits.",
		parameters: fdSchema,
	},
	{
		name: "ls",
		description: "List files and directories in a given path.",
		parameters: lsSchema,
	},
	{
		name: "read",
		description: "Read the entire contents of a file. Each line is prefixed with its line number.",
		parameters: readSchema,
	},
	{
		name: "git",
		description:
			"Run read-only git commands to explore repository history. Allowed subcommands: log, show, blame, diff, shortlog, describe, rev-parse, ls-tree, cat-file.",
		parameters: gitSchema,
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
