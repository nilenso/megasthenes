/**
 * Shared tool command builders + schemas + argument validation.
 *
 * This module is the single source of truth for:
 *   - how tool arguments are described to the LLM (TypeBox schemas),
 *   - how those arguments are validated before dispatch,
 *   - how validated arguments map to shell commands.
 *
 * Keeping these together enforces the invariant that you can't build a shell
 * command without first validating inputs — the router calls `validateToolArgs`
 * before any builder sees the data. The only external runtime dependency in
 * this call graph is `@sinclair/typebox`, which the sandbox worker container
 * also installs, so both the local executor (tools.ts) and the sandbox worker
 * (worker.ts) can import from here.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

// =============================================================================
// Constants
// =============================================================================

const RG_MAX_MATCHES_PER_FILE = 50;

// =============================================================================
// Schemas (LLM-facing parameter definitions)
// =============================================================================

// TypeBox `Object` schemas default to allowing additional properties; we rely
// on that behaviour so the LLM can pass extra fields without breaking the call
// (unknown fields are simply ignored by the builders).

export const rgSchema = Type.Object({
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
});

export const fdSchema = Type.Object({
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
});

export const lsSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "Path to list, relative to repository root. Defaults to root if not specified.",
		}),
	),
});

export const readSchema = Type.Object({
	path: Type.String({
		description: "Path to the file, relative to repository root",
	}),
});

export const gitSchema = Type.Object({
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
});

// =============================================================================
// Types
// =============================================================================

/** Result of building a tool command — either a runnable command or a validation error. */
export type ToolCommand =
	| { ok: true; cmd: string[]; postProcess?: (stdout: string) => string }
	| { ok: false; error: string };

// Argument shapes derived from the TypeBox schemas. Deriving them here (rather
// than maintaining parallel `interface`s) eliminates drift: adding a field to
// a schema automatically flows through to the corresponding builder's param
// type.
type RgArgs = Static<typeof rgSchema>;
type FdArgs = Static<typeof fdSchema>;
type LsArgs = Static<typeof lsSchema>;
type ReadArgs = Static<typeof readSchema>;
type GitArgs = Static<typeof gitSchema>;

type ToolName = "rg" | "fd" | "ls" | "read" | "git";

type ArgsFor<N extends ToolName> = {
	rg: RgArgs;
	fd: FdArgs;
	ls: LsArgs;
	read: ReadArgs;
	git: GitArgs;
}[N];

// =============================================================================
// Argument validation
// =============================================================================

// Compile each schema once at module load — TypeCompiler is ~100x faster than
// Value.Check on the hot path, and tool calls run on every LLM turn.
const validators: Record<ToolName, ReturnType<typeof TypeCompiler.Compile<TSchema>>> = {
	rg: TypeCompiler.Compile(rgSchema),
	fd: TypeCompiler.Compile(fdSchema),
	ls: TypeCompiler.Compile(lsSchema),
	read: TypeCompiler.Compile(readSchema),
	git: TypeCompiler.Compile(gitSchema),
};

/** Format the first TypeBox error as an actionable, human-readable message. */
function formatValidationError(
	toolName: string,
	firstError: { path: string; value: unknown; message: string; schema?: TSchema } | undefined,
): string {
	if (!firstError) return `${toolName}: invalid arguments`;
	// path looks like "/pattern" or "/args/0"; strip the leading slash for readability.
	const field = firstError.path.replace(/^\//, "") || "(root)";

	// When a union-of-literals fails, list the allowed values instead of the
	// opaque "Expected union value" message.
	const anyOf = firstError.schema?.anyOf as { const?: string }[] | undefined;
	const allowed = anyOf?.map((s) => s.const).filter(Boolean);
	if (allowed?.length) {
		return `${toolName}: '${firstError.value}' not allowed for '${field}'. Allowed: ${allowed.join(", ")}`;
	}

	return `${toolName}: ${firstError.message} at '${field}'`;
}

/**
 * Validate tool arguments against the tool's TypeBox schema.
 * Returns a discriminated union so callers can surface errors without throwing.
 *
 * The return type is generic over the tool name so the router can dispatch to
 * per-tool builders without `as` casts at the call site. The single cast inside
 * this function is localized to the point where `validator.Check` has just
 * succeeded — TypeBox's `Check` narrows the input at the value level, but the
 * stringly-keyed `validators` lookup erases the per-tool schema type.
 *
 * Extra/unknown properties are ignored (TypeBox default): schemas do not set
 * `additionalProperties: false`, so the LLM may pass extras without failing.
 */
export function validateToolArgs<N extends ToolName>(
	toolName: N,
	args: unknown,
): { ok: true; value: ArgsFor<N> } | { ok: false; error: string } {
	const validator = validators[toolName];
	if (validator.Check(args)) {
		// `Check` is a type guard at the value level, but the stringly-keyed
		// `validators` lookup erases the per-tool schema type — hence the cast.
		// It's localized to this one post-validation point vs. one per call site.
		return { ok: true, value: args as ArgsFor<N> };
	}
	const [firstError] = [...validator.Errors(args)];
	return { ok: false, error: formatValidationError(toolName, firstError) };
}

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

export function buildRgCommand(args: RgArgs): string[] {
	const maxCount = args.max_count ?? RG_MAX_MATCHES_PER_FILE;
	const cmd = ["rg", "--line-number", "--max-count", String(maxCount), args.pattern];
	if (args.glob) cmd.push("--glob", args.glob);
	if (args.word) cmd.push("-w");
	return cmd;
}

function buildRg(args: RgArgs): ToolCommand {
	const cmd = buildRgCommand(args);
	const maxResults = args.max_results;

	const postProcess = maxResults
		? (output: string) => {
				if (output.startsWith("Error")) return output;
				const lines = output.split("\n").filter((l) => l.trim().length > 0);
				return lines.slice(0, maxResults).join("\n");
			}
		: undefined;

	return { ok: true, cmd, postProcess };
}

export function buildFdCommand(args: FdArgs): string[] {
	const cmd = ["fd"];

	if (args.type) cmd.push("--type", args.type);
	if (args.hidden) cmd.push("--hidden");
	if (args.glob) cmd.push("--glob");
	if (args.full_path) cmd.push("--full-path");
	if (args.max_depth !== undefined) cmd.push("--max-depth", String(args.max_depth));
	if (args.max_results !== undefined) cmd.push("--max-results", String(args.max_results));
	if (args.exclude) cmd.push("--exclude", args.exclude);

	if (args.extension) {
		for (const ext of args.extension.split(",").map((e) => e.trim())) {
			cmd.push("--extension", ext);
		}
	}

	cmd.push(args.pattern);
	return cmd;
}

function buildFd(args: FdArgs): ToolCommand {
	return { ok: true, cmd: buildFdCommand(args) };
}

function buildLs(args: LsArgs, cwd: string): ToolCommand {
	const path = args.path || ".";
	const fullPath = validateProjectPath(cwd, path);
	if (!fullPath) {
		return { ok: false, error: `Error: invalid project path: ${path}` };
	}
	return { ok: true, cmd: ["ls", "-la", fullPath] };
}

function buildRead(args: ReadArgs, cwd: string): ToolCommand {
	const fullPath = validateProjectPath(cwd, args.path);
	if (!fullPath) {
		return { ok: false, error: `Error: invalid project path: ${args.path}` };
	}
	return {
		ok: true,
		cmd: ["cat", "-n", fullPath],
		postProcess: (output) => {
			if (output.startsWith("Error")) return output;
			return `[File: ${args.path}]\n\n${output}`;
		},
	};
}

function buildGit(args: GitArgs): ToolCommand {
	const gitArgs = args.args ?? [];

	return { ok: true, cmd: ["git", args.command, ...gitArgs] };
}

// =============================================================================
// Router
// =============================================================================

/**
 * Build the shell command for a tool invocation.
 *
 * Validates `args` against the tool's TypeBox schema BEFORE the builder touches
 * them — a missing `pattern` returns a clean validation error instead of being
 * spliced into argv as `undefined`. Returns a runnable command array plus
 * optional post-processing, or a validation error. The caller is responsible
 * for actually executing the command (locally via Bun.spawn, or in a sandbox
 * via bwrap).
 */
export function buildToolCommand(name: string, args: Record<string, unknown>, cwd: string): ToolCommand {
	// Dispatch on the string first so each case narrows `name` to a literal
	// `ToolName`; then the generic `validateToolArgs<N>` return type is
	// precisely `ArgsFor<N>`, and the builder calls need no casts.
	switch (name) {
		case "rg": {
			const v = validateToolArgs("rg", args);
			return v.ok ? buildRg(v.value) : { ok: false, error: v.error };
		}
		case "fd": {
			const v = validateToolArgs("fd", args);
			return v.ok ? buildFd(v.value) : { ok: false, error: v.error };
		}
		case "ls": {
			const v = validateToolArgs("ls", args);
			return v.ok ? buildLs(v.value, cwd) : { ok: false, error: v.error };
		}
		case "read": {
			const v = validateToolArgs("read", args);
			return v.ok ? buildRead(v.value, cwd) : { ok: false, error: v.error };
		}
		case "git": {
			const v = validateToolArgs("git", args);
			return v.ok ? buildGit(v.value) : { ok: false, error: v.error };
		}
		default:
			return { ok: false, error: `Unknown tool: ${name}` };
	}
}
