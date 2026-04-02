# Plan: Unified Tool Execution Across Environments

## Problem

The sandbox worker (`src/sandbox/worker.ts`) duplicates tool definitions and execution logic from `src/tools.ts`. The two implementations have diverged:

- **`rg`**: Worker ignores `max_count`, `max_results`, `word` parameters
- **`fd`**: Worker uses `find` instead of `fd`, with a completely different interface
- **`read`**: Worker uses `cat -n` instead of `readFile`, producing different output
- **`ls`**: Functionally identical but code is duplicated
- **`git`**: Allowlist is hardcoded in both places

Additionally, `tools.ts` assumes `rg` and `fd` are always available. They may not be (e.g., `fd` is not currently installed in the sandbox container).

## Solution — Two Phases

**Phase 1** ([#77](https://github.com/nilenso/ask-forge/issues/77)): Add fallback command support to `tools.ts` — detect `rg`/`fd` availability and fall back to `grep`/`find` when unavailable. Switch `read` to `cat -n`. This phase is self-contained and mergeable independently.

**Phase 2** ([#78](https://github.com/nilenso/ask-forge/issues/78)): Unify sandbox worker with `tools.ts` via runner injection — `executeTool` accepts an optional `CommandRunner` so the same tool logic runs in both local and sandboxed contexts. The worker's duplicated switch/case is replaced with a single `executeTool` call.

---

## Phase 1: Primary and Fallback Command Support

### Command Mapping

#### `rg` → `grep` fallback

| Feature | `rg` (primary) | `grep` (fallback) | Notes |
|---|---|---|---|
| Basic search | `rg --line-number pattern` | `grep -rn pattern .` | |
| Max per file | `--max-count N` | `-m N` | |
| File glob | `--glob '*.ts'` | `--include='*.ts'` | |
| Word match | `-w` | `-w` | |
| `.gitignore` | Respected by default | ❌ Not supported | Acceptable loss |
| Binary skip | Skipped by default | `-I` | |
| Max results | JS truncation | JS truncation | |

#### `fd` → `find` fallback

| Feature | `fd` (primary) | `find` (fallback) | Notes |
|---|---|---|---|
| Pattern match | `fd pattern` (regex on filename) | `find . -name '*pattern*'` | Glob approximation — acceptable loss |
| Type filter | `--type f/d/l/x` | `-type f/d/l` | `x` (executable) → `-type f -perm +111` |
| Extension | `--extension ts` | `-name '*.ts'` | |
| Multiple ext | `--extension ts --extension json` | `\( -name '*.ts' -o -name '*.json' \)` | |
| Max depth | `--max-depth N` | `-maxdepth N` | |
| Max results | `--max-results N` | JS truncation | |
| Hidden files | Excluded by default; `--hidden` includes | Included by default; add `-not -path '*/.*'` to exclude | Inverted default |
| Glob mode | `--glob` (switch from regex to glob) | `-name 'pattern'` (glob is natural for find) | |
| Exclude | `--exclude dir` | `-not -path '*/dir/*'` | |
| Full path | `--full-path` (regex on full path) | `-path '*pattern*'` instead of `-name` | |
| `.gitignore` | Respected by default | ❌ Not supported | Acceptable loss |
| Output | Relative paths | `./` prefixed paths | Strip `./` prefix for consistency |

### Files Affected

| File | Action | Purpose |
|---|---|---|
| `src/tools.ts` | **Modify** | Add tool detection, fallback command builders, switch `read` to `cat -n`, simplify `rg` `max_results` piping |
| `test/tools.test.ts` | **Modify** | Update `read` format assertions, add fallback-specific tests |

### Checkpoint 1.1: Switch `read` to `cat -n` and simplify `rg` `max_results`

**Goal**: Make all tools go through `runCommand` (prerequisite for Phase 2 runner injection).

**Changes to `src/tools.ts`**:
- `executeRead`: Replace `readFile` + JS line-numbering with `runCommand(["cat", "-n", fullPath], repoPath)`. Keep `[File: path]` header and path validation. Error handling changes from try/catch on `readFile` to checking `runCommand` error output.
- `executeRg`: Replace `rg | head -n N` pipe with: run `rg` normally, truncate output to `max_results` lines in JS.

**Test cases** (update `test/tools.test.ts`):

| # | Test | How to test | Outcome |
|---|---|---|---|
| 1 | `read` returns `[File: hello.ts]` header | Call `executeTool("read", { path: "hello.ts" }, repoDir)`. Assert output starts with `[File: hello.ts]`. | ✅ passes (header logic unchanged) |
| 2 | `read` prefixes lines with `cat -n` format | Call `executeTool("read", { path: "hello.ts" }, repoDir)`. Assert output contains a line matching `/^\s+1\t/` (cat -n's tab-delimited format). Assert output does NOT match the old format `/\s+1: /` (colon-delimited). | ✅ update assertion |
| 3 | `read` error for nonexistent file | Call `executeTool("read", { path: "no_such_file.txt" }, repoDir)`. Assert output starts with `Error (exit` (from `runCommand` error path, not `Error reading file:` from the old `readFile` catch). | ✅ update assertion |
| 4 | `read` error for path traversal | Call `executeTool("read", { path: "../../etc/passwd" }, repoDir)`. Assert output contains `Error: invalid project path`. Assert output does NOT contain `root:`. | ✅ passes unchanged |
| 5 | `read` handles empty file | Write an empty file. Call `executeTool("read", ...)`. Assert output contains `[File: empty.txt]`. Assert output contains `(no output)` or is empty after the header (cat -n on empty file produces no lines). | ✅ update assertion |
| 6 | `read` line numbers for multi-line file | Write a 12-line file. Call `executeTool("read", ...)`. Assert output contains a line matching `/^\s+1\t/` and `/^\s+12\t/`. Verify `cat -n` pads to consistent width. | ✅ update assertion |
| 7 | `rg` with `max_results` limits total lines | Create files with many matching lines. Call `executeTool("rg", { pattern: ".", max_results: 2 }, repoDir)`. Split non-empty output lines and assert `length <= 2`. | ✅ passes (behavioral parity) |
| 8 | `rg` no matches is consistent with and without `max_results` | Call `executeTool("rg", { pattern: "zzz_never_zzz", max_results: 10 }, repoDir)`. Assert output starts with `Error (exit 1)` — same as the non-`max_results` path (previously returned `(no matches)` due to `head` pipe). | ✅ update assertion |

**Verification**: `bun run check && bunx tsc --noEmit && bun test`

### Checkpoint 1.2: Add tool detection and fallback builders

**Goal**: Detect `rg`/`fd` availability at startup, build commands using whichever is available.

**Changes to `src/tools.ts`**:
- Add `isAvailable(bin: string): Promise<boolean>` — runs `which <bin>`, caches result in a module-level `Map<string, boolean>`
- Export `buildRgCommand(args): string[]` and `buildGrepCommand(args): string[]`
- Export `buildFdCommand(args): string[]` and `buildFindCommand(args): string[]`
- `executeRg`: detect `rg` availability, delegate to appropriate builder, run via `runCommand`, apply JS truncation for `max_results`
- `executeFd`: detect `fd` availability, delegate to appropriate builder, run via `runCommand`, strip `./` prefix from `find` output
- Export `overrideToolAvailability(bin: string, available: boolean)` for testing (allows forcing fallback path without uninstalling tools)

**Test cases** (add to `test/tools.test.ts`):

| # | Test | How to test | Outcome |
|---|---|---|---|
| 9 | `buildRgCommand` produces correct flags | Call `buildRgCommand({ pattern: "foo", glob: "*.ts", max_count: 5, word: true })`. Assert deep equality: `["rg", "--line-number", "--max-count", "5", "foo", "--glob", "*.ts", "-w"]`. | ✅ |
| 10 | `buildGrepCommand` produces equivalent flags | Call `buildGrepCommand({ pattern: "foo", glob: "*.ts", max_count: 5, word: true })`. Assert deep equality: `["grep", "-rn", "-I", "-m", "5", "--include=*.ts", "-w", "foo", "."]`. | ✅ |
| 11 | `buildRgCommand` with only required `pattern` | Call `buildRgCommand({ pattern: "foo" })`. Assert result is `["rg", "--line-number", "--max-count", "50", "foo"]` (default max_count applied). | ✅ |
| 12 | `buildGrepCommand` with only required `pattern` | Call `buildGrepCommand({ pattern: "foo" })`. Assert result is `["grep", "-rn", "-I", "-m", "50", "foo", "."]` (default max_count applied). | ✅ |
| 13 | `buildFdCommand` produces correct flags for all params | Call `buildFdCommand({ pattern: "foo", type: "f", extension: "ts", max_depth: 2, max_results: 10, hidden: true, glob: true, exclude: "vendor", full_path: true })`. Assert each flag appears: `--type f`, `--extension ts`, `--max-depth 2`, `--max-results 10`, `--hidden`, `--glob`, `--exclude vendor`, `--full-path`, `foo`. | ✅ |
| 14 | `buildFindCommand` produces correct flags for type + extension | Call `buildFindCommand({ pattern: "foo", type: "f", extension: "ts" })`. Assert array contains `-type`, `f`, `-name`, `*.ts`. Assert array contains `-not -path '*/.*'` segments (hidden excluded by default). | ✅ |
| 15 | `buildFindCommand` excludes hidden by default, includes with `hidden: true` | Call `buildFindCommand({ pattern: "foo" })` — assert contains `-not -path` with `*/.*`. Call `buildFindCommand({ pattern: "foo", hidden: true })` — assert does NOT contain that segment. | ✅ |
| 16 | `buildFindCommand` with multiple comma-separated extensions | Call `buildFindCommand({ pattern: ".", extension: "ts, json" })`. Assert the command contains grouped OR: `(`, `-name`, `*.ts`, `-o`, `-name`, `*.json`, `)`. | ✅ |
| 17 | `buildFindCommand` with `exclude` | Call `buildFindCommand({ pattern: ".", exclude: "vendor" })`. Assert contains `-not`, `-path`, `*/vendor/*`. | ✅ |
| 18 | `buildFindCommand` with `max_depth` | Call `buildFindCommand({ pattern: ".", max_depth: 1 })`. Assert contains `-maxdepth`, `1`. | ✅ |
| 19 | `buildFindCommand` with `full_path` uses `-path` instead of `-name` | Call `buildFindCommand({ pattern: "src/app", full_path: true })`. Assert contains `-path` and `*src/app*`. Assert does NOT contain `-name`. | ✅ |
| 20 | `buildFindCommand` with `glob: true` uses exact pattern in `-name` | Call `buildFindCommand({ pattern: "*.ts", glob: true })`. Assert `-name` is `*.ts` (not wrapped in extra wildcards). | ✅ |
| 21 | Forced `rg` fallback returns matching lines with line numbers | Call `overrideToolAvailability("rg", false)`. Write a file with known content. Call `executeTool("rg", { pattern: "greeting" }, repoDir)`. Assert output contains `hello.ts` and contains a line matching `/\d+.*greeting/`. Restore override. | ✅ |
| 22 | Forced `fd` fallback returns matching file paths | Call `overrideToolAvailability("fd", false)`. Call `executeTool("fd", { pattern: "hello" }, repoDir)`. Assert output contains `hello.ts`. Assert output lines do NOT start with `./` (stripped). Restore override. | ✅ |
| 23 | Forced `rg` fallback respects `glob` filter | Override `rg` unavailable. Call `executeTool("rg", { pattern: "hello", glob: "*.ts" }, repoDir)`. Assert output contains `hello.ts`. Assert output does NOT contain `hello.json`. | ✅ |
| 24 | Forced `rg` fallback respects `word` flag | Override `rg` unavailable. Write file with "app" and "application". Call `executeTool("rg", { pattern: "app", word: true, glob: "words.txt" }, repoDir)`. Assert output contains "app", does NOT contain "application". | ✅ |
| 25 | Forced `fd` fallback respects `type: "f"` | Override `fd` unavailable. Call `executeTool("fd", { pattern: ".", type: "f" }, repoDir)`. Assert output contains file names. Assert output does NOT contain directory names like `src` or `nested`. | ✅ |
| 26 | Forced `fd` fallback respects `extension` filter | Override `fd` unavailable. Call `executeTool("fd", { pattern: ".", extension: "json" }, repoDir)`. Assert output contains `hello.json`. Assert output does NOT contain `hello.ts`. | ✅ |
| 27 | Forced `fd` fallback excludes hidden by default | Override `fd` unavailable. Write `.hidden_config`. Call `executeTool("fd", { pattern: "hidden_config" }, repoDir)`. Assert output does NOT contain `.hidden_config`. Call again with `hidden: true`. Assert output contains `.hidden_config`. | ✅ |
| 28 | Forced `fd` fallback respects `max_depth` | Override `fd` unavailable. Call `executeTool("fd", { pattern: ".", type: "f", max_depth: 1 }, repoDir)`. Assert output contains `hello.ts` (root level). Assert output does NOT contain `app.ts` (depth 2) or `file.txt` (depth 3). | ✅ |

**Verification**: `bun run check && bunx tsc --noEmit && bun test`

---

## Phase 2: Tool Call Consistency Across Environments

### Files Affected

| File | Action | Purpose |
|---|---|---|
| `src/tools.ts` | **Modify** | Export `CommandRunner` type, add optional runner param to `executeTool`, export `ALLOWED_GIT_COMMANDS` |
| `src/sandbox/worker.ts` | **Modify** | Import `executeTool`, replace duplicated switch with single call + sandbox runner |
| `src/sandbox/Containerfile` | **Modify** | Install `fd`, copy `tools.ts` |
| `test/tools.test.ts` | **Modify** | Add runner injection tests |
| `test/sandbox/worker.test.ts` | **Create** | Unit tests for sandbox runner wiring |

### Checkpoint 2.1: Add `CommandRunner` injection to `executeTool`

**Goal**: `executeTool` accepts an optional runner, defaulting to `Bun.spawn`-based `runCommand`.

**Changes to `src/tools.ts`**:
- Export `type CommandRunner = (cmd: string[], cwd: string) => Promise<string>`
- `executeTool(toolName, args, repoPath, runner?)` — threads runner to each `execute*` function
- Default runner is the existing `runCommand` (uses `Bun.spawn`)
- Export `ALLOWED_GIT_COMMANDS` constant (extracted from the TypeBox union literals; the schema references this constant)

**Test cases** (add to `test/tools.test.ts`):

| # | Test | How to test | Outcome |
|---|---|---|---|
| 29 | Default runner backward compat | Call `executeTool("rg", { pattern: "greeting" }, repoDir)` (no runner arg). Assert output contains `hello.ts`. Compare output to calling with explicit `undefined` runner — must be identical. | ✅ |
| 30 | Mock runner receives `rg` command | Create mock runner `(cmd, cwd) => { captured = { cmd, cwd }; return "(mocked)"; }`. Call `executeTool("rg", { pattern: "foo", glob: "*.ts", word: true }, repoDir, mockRunner)`. Assert `captured.cmd` deep-equals expected `rg` command array. Assert `captured.cwd` equals `repoDir`. | ✅ |
| 31 | Mock runner receives `fd` command | Same mock pattern. Call `executeTool("fd", { pattern: "bar", type: "f" }, repoDir, mockRunner)`. Assert `captured.cmd` starts with `fd` (or `find` if `fd` unavailable) and contains expected flags. | ✅ |
| 32 | Mock runner receives `ls` command | Same mock pattern. Call `executeTool("ls", { path: "src" }, repoDir, mockRunner)`. Assert `captured.cmd` deep-equals `["ls", "-la", resolve(repoDir, "src")]`. | ✅ |
| 33 | Mock runner receives `read` command | Same mock pattern. Call `executeTool("read", { path: "hello.ts" }, repoDir, mockRunner)`. Assert `captured.cmd` deep-equals `["cat", "-n", resolve(repoDir, "hello.ts")]`. Assert return value contains `[File: hello.ts]` header prepended to mock output. | ✅ |
| 34 | Mock runner receives `git` command | Same mock pattern. Call `executeTool("git", { command: "log", args: ["--oneline"] }, repoDir, mockRunner)`. Assert `captured.cmd` deep-equals `["git", "log", "--oneline"]`. | ✅ |
| 35 | `read` path validation runs before runner | Create mock runner that records all calls. Call `executeTool("read", { path: "../../etc/passwd" }, repoDir, mockRunner)`. Assert mock runner was NEVER called (path rejected before reaching runner). Assert result contains `Error: invalid project path`. | ✅ |
| 36 | `ls` path validation runs before runner | Same pattern. Call `executeTool("ls", { path: "/etc" }, repoDir, mockRunner)`. Assert mock runner was NEVER called. Assert result contains `Error: invalid project path`. | ✅ |
| 37 | `ALLOWED_GIT_COMMANDS` matches TypeBox schema | Import `ALLOWED_GIT_COMMANDS` and `tools` from `tools.ts`. Find the `git` tool in `tools[]`. Extract the literal values from its `command` TypeBox union. Assert `ALLOWED_GIT_COMMANDS` contains exactly those values (same set, same length). | ✅ |

**Verification**: `bun run check && bunx tsc --noEmit && bun test`

### Checkpoint 2.2: Update Containerfile

**Goal**: Container has all preferred tools and access to shared `tools.ts`.

**Changes to `src/sandbox/Containerfile`**:
- Add `fd` to `apk add` line
- Copy `tools.ts` into the container at a path that preserves the import relationship with `worker.ts` (e.g., `/app/tools.ts` with worker at `/app/sandbox/worker.ts`)
- Adjust `CMD` if worker path changes

**Test cases**:

| # | Test | How to test | Outcome |
|---|---|---|---|
| 38 | Container builds with `fd` | Run `docker build` on the Containerfile. Assert exit code 0. | ✅ (manual / CI) |
| 39 | `fd` is available inside container | Run `docker run --rm <image> which fd`. Assert exit code 0 and output contains a path. | ✅ (manual / CI) |
| 40 | `tools.ts` is present in container | Run `docker run --rm <image> ls /app/tools.ts`. Assert exit code 0. | ✅ (manual / CI) |

**Verification**: Container builds without errors.

### Checkpoint 2.3: Wire up sandbox worker

**Goal**: Replace worker's duplicated tool logic with `executeTool` + sandbox runner.

**Changes to `src/sandbox/worker.ts`**:
- Import `executeTool`, `ALLOWED_GIT_COMMANDS`, `type CommandRunner` from `../tools`
- Create `makeSandboxRunner(worktree: string): CommandRunner` — calls `runToolIsolated(cmd, worktree)` which wraps with bwrap + seccomp
- `handleTool` for non-git tools: `const output = await executeTool(name, args, worktree, sandboxRunner)`
- `git` case: validate with shared `ALLOWED_GIT_COMMANDS`, keep `isolatedGitToolCommand` wrapping (mounts bare repo read-only — different bwrap topology)
- Delete: `rg`, `find`, `ls`, `read` switch cases, `validatePath` function

**Test cases** (`test/sandbox/worker.test.ts` — new unit tests, no running sandbox required):

| # | Test | How to test | Outcome |
|---|---|---|---|
| 41 | Tool name parity | Import `tools` from `tools.ts`. Extract `tools.map(t => t.name)`. Import the handler from worker (or inspect the code path). Assert every tool name in `tools[]` is handled by the worker (either via `executeTool` pass-through or explicit `git` case). Assert no tool names in the worker that aren't in `tools[]`. | ✅ |
| 42 | Non-git tools delegate to `executeTool` | Mock `executeTool` (or inspect that `handleTool` calls it). Call `handleTool({ slug, sha, name: "rg", args: { pattern: "foo" } })`. Assert `executeTool` was called with `("rg", { pattern: "foo" }, worktree, <a function>)`. Assert the runner argument is a function (the sandbox runner). | ✅ |
| 43 | Sandbox runner wraps with bwrap | Create `makeSandboxRunner(worktree)`. Inspect or mock `runToolIsolated`. Call the runner with `["rg", "--line-number", "foo"]`. Assert `runToolIsolated` was called with the same `cmd` and `worktree`. | ✅ |
| 44 | `git` does NOT use the standard sandbox runner | Mock `executeTool`. Call `handleTool({ slug, sha, name: "git", args: { command: "log" } })`. Assert `executeTool` was NOT called. Assert `isolatedGitToolCommand` was called instead. | ✅ |
| 45 | `git` allowlist uses shared constant | Import `ALLOWED_GIT_COMMANDS` from `tools.ts`. Call `handleTool` with `name: "git", args: { command: "fetch" }`. Assert response is 400 with error containing "not allowed". Call with `command: "log"`. Assert response is OK. The set of accepted/rejected commands must match `ALLOWED_GIT_COMMANDS` exactly. | ✅ |
| 46 | Unknown tool returns 400 | Call `handleTool({ slug, sha, name: "exec", args: {} })`. Assert response status is 400. Assert response body contains `Unknown tool`. | ✅ |

**Existing integration tests** (`test/sandbox/sandbox.integration.test.ts`): No changes — these test via HTTP and should continue passing when sandbox is available.

**Verification**: `bun run check && bunx tsc --noEmit && bun test`. If sandbox available: `sudo just sandbox-up && bun run playground/security-tests.ts sandbox`

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `cat -n` output format differs from `readFile` + JS formatting | Only whitespace difference; `[File:]` header preserved; tests updated with explicit format assertions |
| `grep` fallback lacks `.gitignore` respect | Acceptable — documented limitation; primary tools preferred |
| `find` fallback uses glob approximation instead of regex | Acceptable for fallback; covers common patterns |
| BSD `find` (macOS) vs GNU `find` (container) differences | Only using POSIX-portable flags (`-maxdepth`, `-type`, `-name`, `-not -path`) |
| `git` can't use shared runner (different bwrap mounts) | Explicitly kept as special case with shared validation only |
| Breaking change to `executeTool` signature | Runner param is optional with default — fully backward compatible |
| Container import paths after copying `tools.ts` | Verified in Checkpoint 2.2 test #40 |

## Out of Scope

- Adding new tools
- Changing the sandbox HTTP API or client
- Changing bwrap/seccomp/isolation primitives
- Changing how `Session` or `index.ts` calls `executeTool`
