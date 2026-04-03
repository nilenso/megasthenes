# Changelog

All notable changes to this project will be documented in this file.

## [0.0.18] - 2026-04-02

### Added
* Tool fallback commands: `rg`→`grep` and `fd`→`find` fallback with `cat -n` for `read`
* Line numbers and file header in sandbox `read` tool output
* Tracing support in eval script
* Security vulnerability test suite for sandbox and local mode
* Documentation site with Starlight (configuration guide, sandbox diagram)

### Changed
* Switch sandbox tooling from Podman to Docker
* Improved reasoning prompts
* Refactored thinking config

### Fixed
* Session reopen hanging: handle 404 in clone status polling
* Path traversal blocked in local tools
* Detailed span error recording across failure paths
* Tool error tracing and crash handling normalized
* DNS and seccomp fixes for gVisor compatibility

## [0.0.11] - 2026-02-20

### Added
* `is_reasoning_sound` verdict in the LLM judge evaluation
* Line numbers prepended to `read` tool output for accurate source linking
* `offset` and `limit` parameters for paging through large files with `read`
* Deprecated/legacy code detection — responses now flag superseded code explicitly
* Post-response link validation with broken link ratio tracking
* Dynamic system prompt with permalink URLs for the target repository
* Eval viewer (`scripts/eval/eval-viewer.html`) for visualising and comparing eval runs
* AI-powered analysis of eval run comparisons via OpenRouter

### Changed
* Replaced `is_answer_relevant` with `is_answer_complete` for clearer judge semantics
* Upgraded default model to `claude-sonnet-4.6`

## [0.0.5] - 2026-02-05

### Changed
* Refactored `Session` from factory function to class with dependency injection
* Extracted stream processing to separate `stream-processor.ts` module
* Made stream function and logger injectable via `SessionConfig`

### Added
* `Logger` interface with `consoleLogger` and `nullLogger` exports
* Integration tests for `forge.ts` (10 tests)
* Unit tests for `stream-processor.ts` (13 tests)
* Unit tests for `session.ts` (13 tests)
* Test step added to CI workflow

### Fixed
* TypeScript errors in test files

## [0.0.4] - 2026-02-04

### Changed
* Extracted forge/git logic into `forge.ts`
* Extracted session logic into `session.ts`

## [0.0.3] - 2026-02-04

### Fixed
* Prevent context window overflow with tool output limits
* Fixed installation instructions for JSR package (#4)

## [0.0.2] - 2026-02-03

### Added
* `getMessages()` and `replaceMessages()` methods to `Session` (#3)
* GitHub badges to README

### Changed
* Improved README: tightened description, added requirements, reorganized dev sections

## [0.0.1] - 2026-02-02

Initial release.

### Added
* `connect()` function to connect to GitHub/GitLab repositories
* `Session` class with `ask()` method for querying repositories
* Worktree-based repo isolation with conditional fetching
* Clone locking for concurrent access
* Tools: `rg`, `fd`, `ls`, `read` for repository exploration
* Streaming progress events during inference
* Token usage and inference time tracking in `AskResult`
* Web UI for asking questions and collecting feedback
* Evaluation system with LLM judge (`eval/`)
* CLI entry point (`ask.ts`)
