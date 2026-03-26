import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { Repo } from "../../src/forge";
import { nullLogger } from "../../src/logger";
import { Session, type SessionConfig } from "../../src/session";
import { executeTool, tools } from "../../src/tools";

export interface LocalWorkspace {
	baseDir: string;
	repoDir: string;
	siblingDir: string;
	cleanup: () => Promise<void>;
}

export interface ToolExecutionResult {
	output: string;
	result: Awaited<ReturnType<Session["ask"]>>;
	session: Session;
}

export async function createLocalWorkspace(): Promise<LocalWorkspace> {
	const baseDir = await mkdtemp(join(tmpdir(), "ask-forge-local-tools-"));
	const repoDir = join(baseDir, "repo");
	const siblingDir = join(baseDir, "repo-sibling");

	await mkdir(join(repoDir, "src"), { recursive: true });
	await mkdir(siblingDir, { recursive: true });

	await writeFile(join(repoDir, "README.md"), "# repo readme\n");
	await writeFile(join(repoDir, "src", "main.ts"), "export const value = 1;\n");
	await writeFile(join(siblingDir, "secret.txt"), "sibling secret\n");

	return {
		baseDir,
		repoDir,
		siblingDir,
		cleanup: async () => {
			await rm(baseDir, { recursive: true, force: true });
		},
	};
}

function createRepo(repoPath: string): Repo {
	return {
		url: "https://github.com/nilenso/ask-forge",
		localPath: repoPath,
		cachePath: repoPath,
		commitish: "HEAD",
		forge: {
			name: "github",
			buildCloneUrl: (url: string) => url,
		},
	};
}

function createAssistantResponse(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: { input: 1, output: 1, totalTokens: 2 },
		timestamp: Date.now(),
		api: "test",
		provider: "test",
		model: "test",
		stopReason,
	} as AssistantMessage;
}

function createToolCallResult(name: string, args: Record<string, unknown>) {
	return {
		[Symbol.asyncIterator]: async function* () {
			yield {
				type: "toolcall_delta",
				delta: JSON.stringify(args),
				contentIndex: 0,
				partial: {
					content: [{ type: "toolCall", name }],
				},
			};
			yield {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { name, arguments: args },
			};
		},
		result: async () =>
			createAssistantResponse(
				[
					{
						type: "toolCall",
						id: `tc-${name}`,
						name,
						arguments: args,
					},
				],
				"tool_use",
			),
	};
}

function createFinalTextResult(text: string) {
	return {
		[Symbol.asyncIterator]: async function* () {
			yield { type: "text_delta", delta: text };
		},
		result: async () => createAssistantResponse([{ type: "text", text }], "end_turn"),
	};
}

function createToolStream(name: string, args: Record<string, unknown>): SessionConfig["stream"] {
	let callCount = 0;

	return (() => {
		callCount += 1;
		if (callCount === 1) {
			return createToolCallResult(name, args);
		}
		return createFinalTextResult("finished");
	}) as unknown as SessionConfig["stream"];
}

export async function runToolViaAsk(
	repoPath: string,
	toolName: "read" | "ls",
	path: string,
): Promise<ToolExecutionResult> {
	const session = new Session(createRepo(repoPath), {
		model: { id: "mock-model", provider: "mock-provider" } as Model<Api>,
		systemPrompt: "You are a test assistant.",
		tools,
		maxIterations: 2,
		executeTool,
		logger: nullLogger,
		stream: createToolStream(toolName, { path }),
	});

	const result = await session.ask(`${toolName} ${path}`);
	const toolResult = session
		.getMessages()
		.find((message) => message.role === "toolResult" && message.toolName === toolName);
	const output = (toolResult?.content[0] as { text?: string } | undefined)?.text ?? "";

	return { output, result, session };
}
