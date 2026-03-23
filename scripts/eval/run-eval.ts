import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { completeSimple, getModel, type ThinkingLevel } from "@mariozechner/pi-ai";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER, type ThinkingConfig } from "../../src/config";
import { AskForgeClient, buildDefaultSystemPrompt, nullLogger } from "../../src/index";
import { JUDGE_SYSTEM_PROMPT } from "../../src/prompt";
import { type EvalRow, loadRowsFromCsv, writeCsvString } from "./csv";

// =============================================================================
// LLM Judge (commented out — currently using link validation instead)
// =============================================================================

const JUDGE_MODEL_PROVIDER = "openrouter";
const JUDGE_MODEL_NAME = "anthropic/claude-sonnet-4.6";

type JudgeVerdict = "yes" | "no" | "error";

interface JudgeResult {
	is_answer_complete: JudgeVerdict;
	is_evidence_supported: JudgeVerdict;
	is_evidence_linked: JudgeVerdict;
	is_reasoning_sound: JudgeVerdict;
	misc_feedback: string;
}

async function judge(question: string, answer: string): Promise<JudgeResult> {
	// biome-ignore lint/suspicious/noExplicitAny: model ID not yet in SDK types
	const model = getModel(JUDGE_MODEL_PROVIDER, JUDGE_MODEL_NAME as any);

	const userMessage = `## Question
${question}

## Answer
${answer}`;

	const response = await completeSimple(model, {
		systemPrompt: JUDGE_SYSTEM_PROMPT,
		messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
	});

	const text = response.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { type: "text"; text: string }).text)
		.join("");

	// Strip markdown code fences if present
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/m, "")
		.replace(/\n?```\s*$/m, "")
		.trim();

	const parsed = JSON.parse(cleaned) as JudgeResult;

	// Normalize yes/no values
	const normalize = (field: string, v: string | undefined): JudgeVerdict => {
		if (v == null) {
			console.error(`Judge error: field "${field}" is missing from response`);
			return "error";
		}
		const lower = v.toLowerCase();
		if (lower.startsWith("yes")) return "yes";
		if (lower.startsWith("no")) return "no";
		console.error(`Judge error: field "${field}" has unrecognized value: "${v}"`);
		return "error";
	};

	return {
		is_answer_complete: normalize("is_answer_complete", parsed.is_answer_complete),
		is_evidence_supported: normalize("is_evidence_supported", parsed.is_evidence_supported),
		is_evidence_linked: normalize("is_evidence_linked", parsed.is_evidence_linked),
		is_reasoning_sound: normalize("is_reasoning_sound", parsed.is_reasoning_sound),
		misc_feedback: typeof parsed.misc_feedback === "string" ? parsed.misc_feedback : "",
	};
}

// =============================================================================
// Main
// =============================================================================

async function runEval(inputPath: string, thinking: ThinkingConfig | undefined): Promise<void> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
	const reportsDir = new URL("reports/", import.meta.url).pathname;
	await mkdir(reportsDir, { recursive: true });
	const outputPath = `${reportsDir}eval_${timestamp}.csv`;

	let rows: EvalRow[];
	try {
		rows = await loadRowsFromCsv(inputPath);
	} catch (error) {
		console.error(`Error loading dataset: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	console.log(`Reading dataset from: ${inputPath}`);
	console.log(`Found ${rows.length} rows to evaluate`);
	if (thinking) {
		console.log(`Thinking: ${thinking.level}`);
	}
	console.log();

	const client = new AskForgeClient(
		{
			provider: MODEL_PROVIDER,
			model: MODEL_NAME,
			maxIterations: MAX_TOOL_ITERATIONS,
			thinking,
		},
		nullLogger,
	);

	const askModelLabel = `${MODEL_PROVIDER}/${MODEL_NAME}`;
	const judgeModelLabel = `${JUDGE_MODEL_PROVIDER}/${JUDGE_MODEL_NAME}`;
	const judgePromptText = JUDGE_SYSTEM_PROMPT;

	const resultRows: EvalRow[] = [];
	let sumTotalLinks = 0;
	let sumBrokenLinks = 0;

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!row) continue;
		const { repository, commit_id, question } = row;
		console.log(`\n[${i + 1}/${rows.length}] Asking: "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}"`);
		console.log(`  Repo: ${repository} @ ${commit_id.slice(0, 12)}`);

		const askSystemPrompt = buildDefaultSystemPrompt(repository, commit_id);

		let session: Awaited<ReturnType<typeof client.connect>> | null = null;
		try {
			session = await client.connect(repository, { commitish: commit_id });
			const askResult = await session.ask(question);
			const secs = (askResult.inferenceTimeMs / 1000).toFixed(1);
			console.log(
				`  ✓ Got response (${askResult.response.length} chars, ${askResult.toolCalls.length} tool calls, ${secs}s, ${askResult.totalLinks} links, ${askResult.invalidLinks.length} broken)`,
			);

			// Format tool calls as a bulleted plain-text list
			const toolCallsStr = askResult.toolCalls.map((tc) => `- ${tc.name}: ${JSON.stringify(tc.arguments)}`).join("\n");

			// Extract file names from read tool calls
			const filesReadStr = askResult.toolCalls
				.filter((tc) => tc.name === "read")
				.map((tc) => {
					const filePath = String(tc.arguments.path ?? tc.arguments.file ?? "");
					const fileName = filePath.split("/").pop() || filePath;
					return `- ${fileName}`;
				})
				.join("\n");

			// Broken links as ratio string
			const totalLinks = askResult.totalLinks;
			const brokenCount = askResult.invalidLinks.length;
			sumTotalLinks += totalLinks;
			sumBrokenLinks += brokenCount;

			// Run LLM judge
			let judgeResult: JudgeResult = {
				is_answer_complete: "error",
				is_evidence_supported: "error",
				is_evidence_linked: "error",
				is_reasoning_sound: "error",
				misc_feedback: "",
			};
			try {
				judgeResult = await judge(question, askResult.response);
				console.log(
					`  ⚖ Judge: complete=${judgeResult.is_answer_complete}, supported=${judgeResult.is_evidence_supported}, linked=${judgeResult.is_evidence_linked}, sound=${judgeResult.is_reasoning_sound}`,
				);
			} catch (err) {
				console.error(`  ⚖ Judge error: ${err instanceof Error ? err.message : String(err)}`);
			}

			resultRows.push({
				...row,
				answer: askResult.response,
				is_answer_complete: judgeResult.is_answer_complete,
				is_evidence_supported: judgeResult.is_evidence_supported,
				is_evidence_linked: judgeResult.is_evidence_linked,
				is_reasoning_sound: judgeResult.is_reasoning_sound,
				misc_feedback: judgeResult.misc_feedback,
				broken_link_ratio: `${brokenCount}/${totalLinks}`,
				tool_calls: toolCallsStr,
				files_read: filesReadStr,
				inference_time_ms: String(askResult.inferenceTimeMs),
				input_tokens: String(askResult.usage.inputTokens),
				output_tokens: String(askResult.usage.outputTokens),
				total_tokens: String(askResult.usage.totalTokens),
				cache_read_tokens: String(askResult.usage.cacheReadTokens),
				cache_write_tokens: String(askResult.usage.cacheWriteTokens),
				ask_model: askModelLabel,
				judge_model: judgeModelLabel,
				ask_system_prompt: askSystemPrompt,
				judge_prompt: judgePromptText,
				reasoning_level: askResult.responseEffort ?? "",
			});
		} catch (error) {
			console.error(`  ✗ Error: ${error instanceof Error ? error.message : String(error)}`);
			resultRows.push({
				...row,
				answer: "",
				is_answer_complete: "",
				is_evidence_supported: "",
				is_evidence_linked: "",
				is_reasoning_sound: "",
				misc_feedback: "",
				broken_link_ratio: "0/0",
				tool_calls: "",
				files_read: "",
				inference_time_ms: "0",
				input_tokens: "0",
				output_tokens: "0",
				total_tokens: "0",
				cache_read_tokens: "0",
				cache_write_tokens: "0",
				ask_model: askModelLabel,
				judge_model: judgeModelLabel,
				ask_system_prompt: askSystemPrompt,
				judge_prompt: judgePromptText,
				reasoning_level: "",
			});
		} finally {
			await session?.close();
		}
	}

	const output = writeCsvString(resultRows);
	await writeFile(outputPath, output, "utf-8");
	console.log(`\n✓ Results written to: ${outputPath}`);

	// Print summary
	const total = resultRows.length;
	const _complete = resultRows.filter((r) => r.is_answer_complete === "yes").length;
	const _evidenced = resultRows.filter((r) => r.is_evidence_supported === "yes").length;
	const _linked = resultRows.filter((r) => r.is_evidence_linked === "yes").length;
	const _soundReasoning = resultRows.filter((r) => r.is_reasoning_sound === "yes").length;

	console.log("\n--- Summary ---");
	console.log(`Total rows:          ${total}`);
	console.log(`Broken links:        ${sumBrokenLinks}/${sumTotalLinks}`);
}

// CLI entry point
const VALID_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "adaptive"]);
const args = process.argv.slice(2);
const thinkingArg = args.find((a) => a.startsWith("--thinking"));
const positionalArgs = args.filter((a) => !a.startsWith("--"));
const inputPath = positionalArgs[0];

if (!inputPath) {
	console.error("Usage: bun run eval/run-eval.ts <path-to-dataset.csv> [--thinking[=<level>]]");
	console.error("  --thinking           adaptive (model decides effort, Anthropic-only)");
	console.error("  --thinking=<level>   minimal, low, medium, high, xhigh, adaptive");
	process.exit(1);
}

let thinking: ThinkingConfig | undefined;
if (thinkingArg) {
	const value = thinkingArg.includes("=") ? thinkingArg.split("=")[1] : undefined;
	const level = value ?? "adaptive";
	if (!VALID_LEVELS.has(level)) {
		console.error(`Invalid level: "${level}". Must be one of: ${[...VALID_LEVELS].join(", ")}`);
		process.exit(1);
	}
	thinking = { level: level as ThinkingLevel | "adaptive" };
}

await runEval(inputPath, thinking);
