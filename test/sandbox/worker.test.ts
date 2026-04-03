/**
 * Unit tests for sandbox worker tool execution consistency.
 *
 * These tests verify that the worker uses shared tool definitions from tools.ts
 * rather than duplicating tool logic. They don't require a running sandbox.
 *
 * Behavioral tests for CommandRunner injection, path validation, and
 * ALLOWED_GIT_COMMANDS are in test/tools.test.ts. Integration tests
 * (requiring a running sandbox) are in test/sandbox/sandbox.integration.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { ALLOWED_GIT_COMMANDS } from "../../src/tools";

// ---------------------------------------------------------------------------
// ALLOWED_GIT_COMMANDS consistency
// ---------------------------------------------------------------------------
describe("ALLOWED_GIT_COMMANDS", () => {
	test("contains all expected read-only git subcommands", () => {
		const expected = ["log", "show", "blame", "diff", "shortlog", "describe", "rev-parse", "ls-tree", "cat-file"];
		for (const cmd of expected) {
			expect(ALLOWED_GIT_COMMANDS.has(cmd)).toBe(true);
		}
		expect(ALLOWED_GIT_COMMANDS.size).toBe(expected.length);
	});

	test("does NOT contain write commands", () => {
		const writeCommands = ["push", "fetch", "pull", "merge", "rebase", "commit", "checkout", "branch", "tag"];
		for (const cmd of writeCommands) {
			expect(ALLOWED_GIT_COMMANDS.has(cmd)).toBe(false);
		}
	});
});
