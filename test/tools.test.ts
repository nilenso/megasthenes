import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFdCommand,
	buildFindCommand,
	buildGrepCommand,
	buildRgCommand,
	executeTool,
	overrideToolAvailability,
} from "../src/tools";

let repoDir: string;

beforeEach(async () => {
	repoDir = await mkdtemp(join(tmpdir(), "megasthenes-tools-"));

	await mkdir(join(repoDir, "src"), { recursive: true });
	await mkdir(join(repoDir, "nested", "deep"), { recursive: true });
	await mkdir(join(repoDir, "vendor"), { recursive: true });

	await writeFile(join(repoDir, "hello.ts"), "const greeting = 'hello world';\nconsole.log(greeting);\n");
	await writeFile(join(repoDir, "hello.json"), '{"message": "hello"}\n');
	await writeFile(join(repoDir, "src", "app.ts"), "export function app() { return 'hello'; }\n");
	await writeFile(join(repoDir, "src", "utils.ts"), "export const add = (a: number, b: number) => a + b;\n");
	await writeFile(join(repoDir, "nested", "deep", "file.txt"), "deep content\n");
	await writeFile(join(repoDir, "vendor", "lib.js"), "module.exports = {};\n");

	// Initialise a git repo so `rg` respects .gitignore defaults
	const init = Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
	await init.exited;
	const add = Bun.spawn(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
	await add.exited;
	const commit = Bun.spawn(["git", "commit", "-m", "init", "--no-gpg-sign"], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	await commit.exited;
});

afterEach(async () => {
	await rm(repoDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// executeTool — router & unknown tool
// ---------------------------------------------------------------------------
describe("executeTool router", () => {
	test("returns 'Unknown tool' for unrecognised tool name", async () => {
		const result = await executeTool("nonexistent_tool", {}, repoDir);
		expect(result).toBe("Unknown tool: nonexistent_tool");
	});

	test("dispatches 'rg' to ripgrep", async () => {
		const result = await executeTool("rg", { pattern: "greeting" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toContain("greeting");
	});

	test("dispatches 'fd' to fd", async () => {
		const result = await executeTool("fd", { pattern: "hello" }, repoDir);
		expect(result).toContain("hello.ts");
	});

	test("dispatches 'read' to file reader", async () => {
		const result = await executeTool("read", { path: "hello.ts" }, repoDir);
		expect(result).toContain("[File: hello.ts]");
		expect(result).toContain("greeting");
	});

	test("dispatches 'ls' to directory listing", async () => {
		const result = await executeTool("ls", { path: "src" }, repoDir);
		expect(result).toContain("app.ts");
		expect(result).toContain("utils.ts");
	});

	test("dispatches 'git' to git commands", async () => {
		const result = await executeTool("git", { command: "log", args: ["--oneline", "-1"] }, repoDir);
		expect(result).toMatch(/^[a-f0-9]+ /);
	});
});

// ---------------------------------------------------------------------------
// executeRg — argument handling
// ---------------------------------------------------------------------------
describe("executeRg", () => {
	test("basic pattern match returns matching lines with line numbers", async () => {
		const result = await executeTool("rg", { pattern: "greeting" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toMatch(/\d+:/); // line-number format
	});

	test("glob filter restricts matches to matching files", async () => {
		// Both hello.ts and hello.json contain 'hello', but glob restricts to .ts
		const result = await executeTool("rg", { pattern: "hello", glob: "*.ts" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("hello.json");
	});

	test("max_count limits matches per file", async () => {
		// hello.ts has 2 lines — set max_count to 1
		const result = await executeTool("rg", { pattern: ".", glob: "hello.ts", max_count: 1 }, repoDir);
		const matchingLines = result.split("\n").filter((l) => l.includes("hello.ts"));
		expect(matchingLines.length).toBe(1);
	});

	test("max_results limits total output lines", async () => {
		// Pattern '.' matches all lines across all files. Limit to 2 total.
		const result = await executeTool("rg", { pattern: ".", max_results: 2 }, repoDir);
		const nonEmptyLines = result.split("\n").filter((l) => l.trim().length > 0);
		expect(nonEmptyLines.length).toBeLessThanOrEqual(2);
	});

	test("word flag enables whole-word matching", async () => {
		// 'app' should match the function name, but not 'app.ts' in path context
		// Write a file with 'app' as a standalone word and 'application' as a non-match
		await writeFile(join(repoDir, "words.txt"), "app\napplication\nmy app here\n");
		const result = await executeTool("rg", { pattern: "app", word: true, glob: "words.txt" }, repoDir);
		expect(result).toContain("app");
		expect(result).not.toContain("application");
	});

	test("no matches returns error exit 1 without max_results", async () => {
		// rg exits 1 when no matches found; runCommand surfaces this as an error string
		const result = await executeTool("rg", { pattern: "zzz_never_matches_zzz" }, repoDir);
		expect(result).toContain("Error (exit 1)");
	});

	test("no matches with max_results returns same error as without", async () => {
		const result = await executeTool("rg", { pattern: "zzz_never_matches_zzz", max_results: 10 }, repoDir);
		// Now consistent: rg exits 1 for no matches regardless of max_results
		expect(result).toContain("Error (exit 1)");
	});

	test("invalid regex returns error", async () => {
		const result = await executeTool("rg", { pattern: "[invalid" }, repoDir);
		expect(result).toStartWith("Error (exit 2):");
		expect(result).toContain("regex parse error");
	});

	test("defaults max_count to RG_MAX_MATCHES_PER_FILE (50) when omitted", async () => {
		// Create a file with 60 lines, all matching 'line'
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
		await writeFile(join(repoDir, "many_lines.txt"), lines);

		const result = await executeTool("rg", { pattern: "line", glob: "many_lines.txt" }, repoDir);
		const matchingLines = result.split("\n").filter((l) => l.includes("line"));
		expect(matchingLines.length).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// executeFd — argument handling
// ---------------------------------------------------------------------------
describe("executeFd", () => {
	test("basic pattern finds matching filenames", async () => {
		const result = await executeTool("fd", { pattern: "app" }, repoDir);
		expect(result).toContain("app.ts");
	});

	test("type 'f' returns only files, not directories", async () => {
		const result = await executeTool("fd", { pattern: ".", type: "f" }, repoDir);
		// All results should be files, not the 'src' or 'nested' directories
		const lines = result.split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			expect(line).toMatch(/\.\w+$/); // has a file extension
		}
	});

	test("type 'd' returns only directories", async () => {
		const result = await executeTool("fd", { pattern: ".", type: "d" }, repoDir);
		expect(result).toContain("src");
		expect(result).toContain("nested");
		// Should not contain files
		expect(result).not.toContain("hello.ts");
		expect(result).not.toContain("app.ts");
	});

	test("extension filter restricts to given extension", async () => {
		const result = await executeTool("fd", { pattern: ".", extension: "json" }, repoDir);
		expect(result).toContain("hello.json");
		expect(result).not.toContain("hello.ts");
	});

	test("comma-separated extensions generate multiple --extension flags", async () => {
		const result = await executeTool("fd", { pattern: ".", extension: "ts, json" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toContain("hello.json");
		expect(result).not.toContain("lib.js");
	});

	test("max_depth restricts search depth", async () => {
		const result = await executeTool("fd", { pattern: ".", type: "f", max_depth: 1 }, repoDir);
		// Root-level files should appear
		expect(result).toContain("hello.ts");
		// Files nested beyond depth 1 should not
		expect(result).not.toContain("deep");
		expect(result).not.toContain("app.ts");
	});

	test("max_results limits number of results", async () => {
		const result = await executeTool("fd", { pattern: ".", type: "f", max_results: 2 }, repoDir);
		const lines = result.split("\n").filter((l) => l.trim().length > 0);
		expect(lines.length).toBeLessThanOrEqual(2);
	});

	test("hidden flag includes dotfiles", async () => {
		await writeFile(join(repoDir, ".hidden_config"), "secret=value\n");
		const withHidden = await executeTool("fd", { pattern: "hidden_config", hidden: true }, repoDir);
		expect(withHidden).toContain(".hidden_config");

		const withoutHidden = await executeTool("fd", { pattern: "hidden_config" }, repoDir);
		expect(withoutHidden).not.toContain(".hidden_config");
	});

	test("glob flag uses glob matching instead of regex", async () => {
		const result = await executeTool("fd", { pattern: "*.ts", glob: true }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toContain("app.ts");
		expect(result).not.toContain("hello.json");
	});

	test("exclude filters out matching paths", async () => {
		const result = await executeTool("fd", { pattern: ".", type: "f", exclude: "vendor" }, repoDir);
		expect(result).not.toContain("lib.js");
		expect(result).toContain("hello.ts");
	});

	test("full_path matches against full path, not just filename", async () => {
		// 'src/app' matches full path but 'src/app' is not a filename pattern
		const result = await executeTool("fd", { pattern: "src/app", full_path: true }, repoDir);
		expect(result).toContain("app.ts");
	});

	test("no matches returns '(no output)'", async () => {
		const result = await executeTool("fd", { pattern: "zzz_never_matches_zzz" }, repoDir);
		expect(result).toContain("(no output)");
	});
});

// ---------------------------------------------------------------------------
// executeRead — file reading
// ---------------------------------------------------------------------------
describe("executeRead", () => {
	test("returns file content with [File: ...] header", async () => {
		const result = await executeTool("read", { path: "hello.ts" }, repoDir);
		expect(result).toStartWith("[File: hello.ts]");
		expect(result).toContain("const greeting = 'hello world';");
	});

	test("prefixes each line with cat -n tab-delimited format", async () => {
		const result = await executeTool("read", { path: "hello.ts" }, repoDir);
		// cat -n uses tab-delimited format: "     1\tline"
		expect(result).toMatch(/\s+1\t.*const greeting/);
		expect(result).toMatch(/\s+2\t.*console\.log/);
		// Must NOT use the old colon-delimited format
		expect(result).not.toMatch(/\s+1: const greeting/);
	});

	test("line numbers are right-aligned for multi-digit counts", async () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
		await writeFile(join(repoDir, "multiline.txt"), lines);

		const result = await executeTool("read", { path: "multiline.txt" }, repoDir);
		// cat -n pads line numbers with spaces and uses tab delimiter
		expect(result).toMatch(/\s+1\tline 1/);
		expect(result).toMatch(/\s+12\tline 12/);
	});

	test("reads file in a subdirectory", async () => {
		const result = await executeTool("read", { path: "src/app.ts" }, repoDir);
		expect(result).toContain("[File: src/app.ts]");
		expect(result).toContain("export function app()");
	});

	test("returns error for nonexistent file", async () => {
		const result = await executeTool("read", { path: "no_such_file.txt" }, repoDir);
		// cat returns non-zero exit code for missing files
		expect(result).toStartWith("Error (exit");
	});

	test("returns error for path traversal with ../", async () => {
		const result = await executeTool("read", { path: "../../etc/passwd" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("returns error for absolute path", async () => {
		const result = await executeTool("read", { path: "/etc/hosts" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("handles empty file", async () => {
		await writeFile(join(repoDir, "empty.txt"), "");
		const result = await executeTool("read", { path: "empty.txt" }, repoDir);
		expect(result).toContain("[File: empty.txt]");
		// cat -n on empty file produces no lines, so runCommand returns "(no output)"
		expect(result).toContain("(no output)");
	});

	test("handles file with special characters in content", async () => {
		await writeFile(join(repoDir, "special.txt"), "line with <html> & \"quotes\" 'apos'\n");
		const result = await executeTool("read", { path: "special.txt" }, repoDir);
		expect(result).toContain("<html>");
		expect(result).toContain("&");
		expect(result).toContain('"quotes"');
	});

	test("returns error for permission-denied file", async () => {
		const restrictedPath = join(repoDir, "restricted.txt");
		await writeFile(restrictedPath, "secret content\n");
		await chmod(restrictedPath, 0o000);

		try {
			const result = await executeTool("read", { path: "restricted.txt" }, repoDir);
			// cat returns non-zero exit code for permission denied
			expect(result).toStartWith("Error (exit");
			expect(result).not.toContain("secret content");
		} finally {
			// Restore permissions so afterEach cleanup can remove it
			await chmod(restrictedPath, 0o644);
		}
	});
});

// ---------------------------------------------------------------------------
// executeLs — directory listing
// ---------------------------------------------------------------------------
describe("executeLs", () => {
	test("lists files in a subdirectory", async () => {
		const result = await executeTool("ls", { path: "src" }, repoDir);
		expect(result).toContain("app.ts");
		expect(result).toContain("utils.ts");
	});

	test("defaults to repo root when path is omitted", async () => {
		const result = await executeTool("ls", {}, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toContain("src");
		expect(result).toContain("nested");
	});

	test("defaults to repo root when path is undefined", async () => {
		const result = await executeTool("ls", { path: undefined }, repoDir);
		expect(result).toContain("hello.ts");
	});

	test("shows detailed listing with ls -la format", async () => {
		const result = await executeTool("ls", { path: "." }, repoDir);
		// ls -la output includes permission strings and total line
		expect(result).toMatch(/total \d+/);
	});

	test("lists nested directory contents", async () => {
		const result = await executeTool("ls", { path: "nested/deep" }, repoDir);
		expect(result).toContain("file.txt");
	});

	test("returns error for path traversal with ../", async () => {
		const result = await executeTool("ls", { path: "../../../" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("returns error for absolute path", async () => {
		const result = await executeTool("ls", { path: "/etc" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("returns error for nonexistent directory", async () => {
		const result = await executeTool("ls", { path: "no_such_dir" }, repoDir);
		expect(result).toStartWith("Error (exit");
	});

	test("includes dotfiles in listing (ls -la shows hidden)", async () => {
		await writeFile(join(repoDir, ".env"), "SECRET=abc\n");
		const result = await executeTool("ls", { path: "." }, repoDir);
		expect(result).toContain(".env");
	});

	test("shows . and .. entries", async () => {
		const result = await executeTool("ls", { path: "src" }, repoDir);
		expect(result).toContain(".");
		expect(result).toContain("..");
	});
});

// ---------------------------------------------------------------------------
// executeGit — git command execution
// ---------------------------------------------------------------------------
describe("executeGit", () => {
	test("git log --oneline -1 returns a commit hash followed by message", async () => {
		const result = await executeTool("git", { command: "log", args: ["--oneline", "-1"] }, repoDir);
		expect(result).toMatch(/^[a-f0-9]+ .+/);
	});

	test("git log without extra args returns log output", async () => {
		const result = await executeTool("git", { command: "log" }, repoDir);
		expect(result).toContain("commit");
		expect(result).toContain("init");
	});

	test("git blame on a known file returns annotated lines with commit hashes", async () => {
		const result = await executeTool("git", { command: "blame", args: ["hello.ts"] }, repoDir);
		expect(result).toMatch(/[a-f0-9]+/);
		expect(result).toContain("greeting");
	});

	test("git show HEAD returns commit details", async () => {
		const result = await executeTool("git", { command: "show", args: ["HEAD"] }, repoDir);
		expect(result).toContain("commit");
		expect(result).toContain("init");
	});

	test("git diff with no changes returns (no output)", async () => {
		const result = await executeTool("git", { command: "diff" }, repoDir);
		expect(result).toBe("(no output)");
	});

	test("git rev-parse HEAD returns a 40-char hex SHA", async () => {
		const result = await executeTool("git", { command: "rev-parse", args: ["HEAD"] }, repoDir);
		expect(result.trim()).toMatch(/^[a-f0-9]{40}$/);
	});

	test("git ls-tree HEAD returns tree listing with file entries", async () => {
		const result = await executeTool("git", { command: "ls-tree", args: ["HEAD"] }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toContain("blob");
	});

	test("git cat-file -t HEAD returns commit", async () => {
		const result = await executeTool("git", { command: "cat-file", args: ["-t", "HEAD"] }, repoDir);
		expect(result.trim()).toBe("commit");
	});

	test("git with no args field defaults to empty array (no crash)", async () => {
		const result = await executeTool("git", { command: "log" }, repoDir);
		expect(result).toContain("init");
	});

	test("git with an invalid subcommand arg returns an error string", async () => {
		const result = await executeTool("git", { command: "log", args: ["--nonexistent-flag"] }, repoDir);
		expect(result).toStartWith("Error (exit");
	});
});

// ---------------------------------------------------------------------------
// validateProjectPath — edge cases (tested indirectly via read/ls)
// ---------------------------------------------------------------------------
describe("validateProjectPath (via read/ls)", () => {
	test("traversal hidden after a valid prefix is rejected", async () => {
		const result = await executeTool("read", { path: "src/../../etc/passwd" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("null byte injection does not allow traversal", async () => {
		const result = await executeTool("read", { path: "hello.ts\0../../etc/passwd" }, repoDir);
		// Null byte truncates the path at the OS level — must not leak external content
		expect(result).not.toContain("root:");
		// Should either read hello.ts safely or return a read error
		const safeRead = result.includes("[File:") || result.includes("Error (exit");
		expect(safeRead).toBe(true);
	});

	test("path with trailing slash does not escape repo", async () => {
		const result = await executeTool("read", { path: "src/" }, repoDir);
		// src/ is a directory — passes path validation but cat fails on directories
		expect(result).toStartWith("Error (exit");
	});

	test("dot path does not escape the repo", async () => {
		const result = await executeTool("read", { path: "." }, repoDir);
		// '.' is a directory — passes path validation but cat fails on directories
		expect(result).toStartWith("Error (exit");
	});

	test("deeply nested traversal is rejected by ls", async () => {
		const result = await executeTool("ls", { path: "src/../../../../../../../etc" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("relative path that resolves inside repo succeeds", async () => {
		const result = await executeTool("read", { path: "src/../hello.ts" }, repoDir);
		expect(result).toContain("[File: src/../hello.ts]");
		expect(result).toContain("const greeting = 'hello world';");
	});

	test("path starting with valid dir then escaping is rejected by ls", async () => {
		const result = await executeTool("ls", { path: "nested/deep/../../../" }, repoDir);
		expect(result).toContain("Error: invalid project path");
	});

	test("empty string path defaults to repo root for ls", async () => {
		const result = await executeTool("ls", { path: "" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toContain("src");
	});
});

// ---------------------------------------------------------------------------
// buildRgCommand / buildGrepCommand — command builders
// ---------------------------------------------------------------------------
describe("buildRgCommand", () => {
	test("produces correct flags for all params", () => {
		const cmd = buildRgCommand({ pattern: "foo", glob: "*.ts", max_count: 5, word: true });
		expect(cmd).toEqual(["rg", "--line-number", "--max-count", "5", "foo", "--glob", "*.ts", "-w"]);
	});

	test("with only required pattern uses default max_count", () => {
		const cmd = buildRgCommand({ pattern: "foo" });
		expect(cmd).toEqual(["rg", "--line-number", "--max-count", "50", "foo"]);
	});
});

describe("buildGrepCommand", () => {
	test("produces equivalent flags", () => {
		const cmd = buildGrepCommand({ pattern: "foo", glob: "*.ts", max_count: 5, word: true });
		expect(cmd).toEqual(["grep", "-rn", "-I", "-m", "5", "--include=*.ts", "-w", "foo", "."]);
	});

	test("with only required pattern uses default max_count", () => {
		const cmd = buildGrepCommand({ pattern: "foo" });
		expect(cmd).toEqual(["grep", "-rn", "-I", "-m", "50", "foo", "."]);
	});
});

// ---------------------------------------------------------------------------
// buildFdCommand / buildFindCommand — command builders
// ---------------------------------------------------------------------------
describe("buildFdCommand", () => {
	test("produces correct flags for all params", () => {
		const cmd = buildFdCommand({
			pattern: "foo",
			type: "f",
			extension: "ts",
			max_depth: 2,
			max_results: 10,
			hidden: true,
			glob: true,
			exclude: "vendor",
			full_path: true,
		});
		expect(cmd).toContain("--type");
		expect(cmd).toContain("f");
		expect(cmd).toContain("--extension");
		expect(cmd).toContain("ts");
		expect(cmd).toContain("--max-depth");
		expect(cmd).toContain("2");
		expect(cmd).toContain("--max-results");
		expect(cmd).toContain("10");
		expect(cmd).toContain("--hidden");
		expect(cmd).toContain("--glob");
		expect(cmd).toContain("--exclude");
		expect(cmd).toContain("vendor");
		expect(cmd).toContain("--full-path");
		expect(cmd).toContain("foo");
	});
});

describe("buildFindCommand", () => {
	test("produces correct flags for type + extension", () => {
		const cmd = buildFindCommand({ pattern: "foo", type: "f", extension: "ts" });
		expect(cmd).toContain("-type");
		expect(cmd).toContain("f");
		expect(cmd).toContain("-name");
		expect(cmd).toContain("*.ts");
		// hidden files excluded by default
		expect(cmd.join(" ")).toContain("-not -path */.*");
	});

	test("excludes hidden by default, includes with hidden: true", () => {
		const withoutHidden = buildFindCommand({ pattern: "foo" });
		expect(withoutHidden.join(" ")).toContain("-not -path */.*");

		const withHidden = buildFindCommand({ pattern: "foo", hidden: true });
		expect(withHidden.join(" ")).not.toContain("-not -path */.*");
	});

	test("with multiple comma-separated extensions uses -o grouping", () => {
		const cmd = buildFindCommand({ pattern: ".", extension: "ts, json" });
		const joined = cmd.join(" ");
		expect(joined).toContain("(");
		expect(joined).toContain("*.ts");
		expect(joined).toContain("-o");
		expect(joined).toContain("*.json");
		expect(joined).toContain(")");
	});

	test("with exclude", () => {
		const cmd = buildFindCommand({ pattern: ".", exclude: "vendor" });
		const joined = cmd.join(" ");
		expect(joined).toContain("-not -path */vendor/*");
	});

	test("with max_depth", () => {
		const cmd = buildFindCommand({ pattern: ".", max_depth: 1 });
		expect(cmd).toContain("-maxdepth");
		expect(cmd).toContain("1");
	});

	test("with full_path uses -path instead of -name", () => {
		const cmd = buildFindCommand({ pattern: "src/app", full_path: true });
		expect(cmd).toContain("-path");
		expect(cmd).toContain("*src/app*");
		expect(cmd).not.toContain("-name");
	});

	test("with glob: true uses exact pattern in -name", () => {
		const cmd = buildFindCommand({ pattern: "*.ts", glob: true });
		const nameIdx = cmd.indexOf("-name");
		expect(nameIdx).not.toBe(-1);
		// glob mode: exact pattern, not wrapped in wildcards
		expect(cmd[nameIdx + 1]).toBe("*.ts");
	});
});

// ---------------------------------------------------------------------------
// Fallback integration tests — forced via overrideToolAvailability
// ---------------------------------------------------------------------------
describe("rg fallback to grep", () => {
	afterEach(() => {
		// Restore real availability
		overrideToolAvailability("rg", true);
	});

	test("returns matching lines with line numbers", async () => {
		overrideToolAvailability("rg", false);
		const result = await executeTool("rg", { pattern: "greeting" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).toMatch(/\d+.*greeting/);
	});

	test("respects glob filter", async () => {
		overrideToolAvailability("rg", false);
		const result = await executeTool("rg", { pattern: "hello", glob: "*.ts" }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("hello.json");
	});

	test("respects word flag", async () => {
		overrideToolAvailability("rg", false);
		await writeFile(join(repoDir, "words.txt"), "app\napplication\nmy app here\n");
		const result = await executeTool("rg", { pattern: "app", word: true, glob: "words.txt" }, repoDir);
		expect(result).toContain("app");
		expect(result).not.toContain("application");
	});
});

describe("fd fallback to find", () => {
	afterEach(() => {
		overrideToolAvailability("fd", true);
	});

	test("returns matching file paths without ./ prefix", async () => {
		overrideToolAvailability("fd", false);
		const result = await executeTool("fd", { pattern: "hello" }, repoDir);
		expect(result).toContain("hello.ts");
		// Lines should not start with ./
		for (const line of result.split("\n").filter((l) => l.trim())) {
			expect(line).not.toMatch(/^\.\//);
		}
	});

	test("respects type: f", async () => {
		overrideToolAvailability("fd", false);
		const result = await executeTool("fd", { pattern: ".", type: "f" }, repoDir);
		expect(result).toContain("hello.ts");
		// Should not contain directory names without extensions
		const lines = result.split("\n").filter((l) => l.trim());
		for (const line of lines) {
			expect(line).toMatch(/\.\w+$/); // has a file extension
		}
	});

	test("respects extension filter", async () => {
		overrideToolAvailability("fd", false);
		const result = await executeTool("fd", { pattern: ".", extension: "json" }, repoDir);
		expect(result).toContain("hello.json");
		expect(result).not.toContain("hello.ts");
	});

	test("excludes hidden files by default", async () => {
		overrideToolAvailability("fd", false);
		await writeFile(join(repoDir, ".hidden_config"), "secret=value\n");

		const withoutHidden = await executeTool("fd", { pattern: "hidden_config" }, repoDir);
		expect(withoutHidden).not.toContain(".hidden_config");

		const withHidden = await executeTool("fd", { pattern: "hidden_config", hidden: true }, repoDir);
		expect(withHidden).toContain(".hidden_config");
	});

	test("respects max_depth", async () => {
		overrideToolAvailability("fd", false);
		const result = await executeTool("fd", { pattern: ".", type: "f", max_depth: 1 }, repoDir);
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("app.ts");
		expect(result).not.toContain("file.txt");
	});
});
