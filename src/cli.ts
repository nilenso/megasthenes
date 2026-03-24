#!/usr/bin/env bun
// Enable OSC 8 clickable hyperlinks in terminal output.
// Must be set before supports-hyperlinks is imported (it evaluates at load time).
process.env.FORCE_HYPERLINK = "1";

import "dotenv/config";
import { Marked } from "marked";
// @ts-expect-error -- no up-to-date type declarations
import { markedTerminal } from "marked-terminal";
import { MAX_TOOL_ITERATIONS, MODEL_NAME, MODEL_PROVIDER } from "./config";
import { AskForgeClient, type OnProgress } from "./index";

// =============================================================================
// Argument parsing
// =============================================================================

interface CliArgs {
	repo: string;
	question: string;
	commitish?: string;
	provider: string;
	model: string;
	maxIterations: number;
	json: boolean;
	quiet: boolean;
}

function printUsage(): void {
	console.error(`ask - Ask questions about a GitHub/GitLab repository

Usage:
  ask <repo-url> <question> [options]

Arguments:
  repo-url    URL of the repository (e.g. https://github.com/owner/repo)
  question    Question to ask about the repository

Options:
  -c, --commitish <ref>       Commit SHA, branch, tag, or relative ref (e.g. HEAD~1)
  -p, --provider <provider>   Model provider (default: ${MODEL_PROVIDER})
  -m, --model <model>         Model name (default: ${MODEL_NAME})
  -i, --max-iterations <n>    Max tool-use iterations (default: ${MAX_TOOL_ITERATIONS})
  -j, --json                  Output result as JSON
  -q, --quiet                 Suppress progress output
  -h, --help                  Show this help message

Environment:
  OPENROUTER_API_KEY    API key for OpenRouter (default provider)
  ANTHROPIC_API_KEY     API key for Anthropic
`);
}

function nextArg(argv: string[], i: number, flag: string): string {
	const val = argv[i + 1];
	if (!val) die(`Missing value for ${flag}`);
	return val;
}

function parseArgs(argv: string[]): CliArgs {
	const positional: string[] = [];
	let commitish: string | undefined;
	let provider: string = MODEL_PROVIDER;
	let model: string = MODEL_NAME;
	let maxIterations = MAX_TOOL_ITERATIONS;
	let json = false;
	let quiet = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;

		if (arg === "-h" || arg === "--help") {
			printUsage();
			process.exit(0);
		} else if (arg === "-c" || arg === "--commitish") {
			commitish = nextArg(argv, i, arg);
			i++;
		} else if (arg === "-p" || arg === "--provider") {
			provider = nextArg(argv, i, arg);
			i++;
		} else if (arg === "-m" || arg === "--model") {
			model = nextArg(argv, i, arg);
			i++;
		} else if (arg === "-i" || arg === "--max-iterations") {
			const raw = nextArg(argv, i, arg);
			i++;
			maxIterations = Number.parseInt(raw, 10);
			if (Number.isNaN(maxIterations) || maxIterations < 1) {
				die("--max-iterations must be a positive integer");
			}
		} else if (arg === "-j" || arg === "--json") {
			json = true;
		} else if (arg === "-q" || arg === "--quiet") {
			quiet = true;
		} else if (arg.startsWith("-")) {
			die(`Unknown option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}

	if (positional.length < 2) {
		printUsage();
		process.exit(1);
	}

	return {
		repo: positional[0]!,
		question: positional[1]!,
		commitish,
		provider,
		model,
		maxIterations,
		json,
		quiet,
	};
}

// =============================================================================
// Helpers
// =============================================================================

function die(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

function summarizeArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([k, v]) => {
			const s = String(v);
			return `${k}=${s.length > 40 ? `${s.slice(0, 37)}...` : s}`;
		})
		.join(", ");
}

function createProgressHandler(quiet: boolean): OnProgress | undefined {
	if (quiet) return undefined;

	return (event) => {
		switch (event.type) {
			case "thinking":
				process.stderr.write("🤔 Thinking...\n");
				break;
			case "tool_start":
				process.stderr.write(`🔧 ${event.name}(${summarizeArgs(event.arguments)})\n`);
				break;
			case "tool_end":
				process.stderr.write(`   ✓ ${event.name} done\n`);
				break;
			case "responding":
				process.stderr.write("📝 Responding...\n");
				break;
		}
	};
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const client = new AskForgeClient({
		provider: args.provider as "openrouter",
		model: args.model,
		maxIterations: args.maxIterations,
	});

	if (!args.quiet) {
		process.stderr.write(`Connecting to ${args.repo}...\n`);
	}

	const session = await client.connect(args.repo, {
		commitish: args.commitish,
	});

	if (!args.quiet) {
		process.stderr.write(`Connected (${session.repo.commitish?.slice(0, 8) ?? "HEAD"})\n\n`);
	}

	const onProgress = createProgressHandler(args.quiet);
	const result = await session.ask(args.question, { onProgress });

	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const marked = new Marked(markedTerminal());
		const rendered = marked.parse(result.response) as string;
		process.stdout.write(rendered);
	}

	await session.close();
}

main().catch((error) => {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
