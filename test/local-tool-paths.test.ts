import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { createLocalWorkspace, type LocalWorkspace, runToolViaAsk } from "./helpers/local-tool-harness";

describe("local tool project path validation", () => {
	let workspace: LocalWorkspace;

	beforeEach(async () => {
		workspace = await createLocalWorkspace();
	});

	afterEach(async () => {
		await workspace.cleanup();
	});

	test("read allows an in-repo file", async () => {
		const { output } = await runToolViaAsk(workspace.repoDir, "read", "README.md");

		expect(output).toContain("[File: README.md]");
		expect(output).toContain("# repo readme");
	});

	test("ls allows an in-repo directory", async () => {
		const { output } = await runToolViaAsk(workspace.repoDir, "ls", ".");

		expect(output).toContain("README.md");
		expect(output).toContain("src");
	});

	test("read rejects parent-directory traversal", async () => {
		const { output } = await runToolViaAsk(workspace.repoDir, "read", "../../../../etc/hosts");

		expect(output).toContain("Error: invalid project path");
		expect(output).not.toContain("Host Database");
	});

	test("read rejects absolute paths", async () => {
		const { output } = await runToolViaAsk(workspace.repoDir, "read", "/etc/hosts");

		expect(output).toContain("Error: invalid project path");
	});

	test("read rejects sibling-prefix escapes", async () => {
		const siblingPath = `../${basename(workspace.siblingDir)}/secret.txt`;
		const { output } = await runToolViaAsk(workspace.repoDir, "read", siblingPath);

		expect(output).toContain("Error: invalid project path");
		expect(output).not.toContain("sibling secret");
	});

	test("ls rejects parent-directory traversal", async () => {
		const { output } = await runToolViaAsk(workspace.repoDir, "ls", "../../../");

		expect(output).toContain("Error: invalid project path");
	});

	test("ls rejects absolute paths", async () => {
		const { output } = await runToolViaAsk(workspace.repoDir, "ls", "/etc");

		expect(output).toContain("Error: invalid project path");
	});

	test("ls rejects sibling-prefix escapes", async () => {
		const siblingPath = `../${basename(workspace.siblingDir)}`;
		const { output } = await runToolViaAsk(workspace.repoDir, "ls", siblingPath);

		expect(output).toContain("Error: invalid project path");
		expect(output).not.toContain("secret.txt");
	});
});
