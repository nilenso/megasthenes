#!/usr/bin/env bun

/**
 * CLI script to test the megasthenes ask() API.
 * Outputs JSON to stdout; progress/status to stderr.
 *
 * Usage:
 *   bun scripts/test-ask.ts <repo-url> <prompt> [options]
 *
 * Options:
 *   --provider <p>       Model provider (default: "anthropic")
 *   --model <m>          Model ID (default: "claude-sonnet-4-6")
 *   --max-iterations <n> Max tool-use iterations (default: 20)
 *   --stream             Print each stream event as NDJSON instead of the final result
 *   --commitish <ref>    Git ref to checkout (branch, tag, SHA)
 *   --thinking <effort>  Enable thinking with effort level (e.g. "medium", "high")
 *   --abort <ms>         Abort the turn after N milliseconds
 *   --abort-immediate    Pass a pre-aborted signal (turn never starts)
 *
 * Examples:
 *   bun scripts/test-ask.ts https://github.com/user/repo "What does this project do?"
 *   bun scripts/test-ask.ts https://github.com/user/repo "List all files" --stream
 *   bun scripts/test-ask.ts file:///path/to/repo.git "Explain src/" --model claude-opus-4-6
 */

import type { ThinkingConfig } from "../src/config";
import { Client, nullLogger, type SessionConfig } from "../src/index";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name: string): boolean {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

function option(name: string, fallback: string): string {
	const i = args.indexOf(`--${name}`);
	if (i === -1 || i + 1 >= args.length) return fallback;
	const val = args[i + 1] as string;
	args.splice(i, 2);
	return val;
}

const streamMode = flag("stream");
const abortImmediate = flag("abort-immediate");
const abortMs = Number(option("abort", "0"));
const provider = option("provider", "anthropic");
const modelId = option("model", "claude-sonnet-4-6");
const maxIterations = Number(option("max-iterations", "20"));
const commitish = option("commitish", "");
const thinkingEffort = option("thinking", "");

const repoUrl = args[0];
const prompt = args[1];

if (!repoUrl || !prompt) {
	console.error("Usage: bun scripts/test-ask.ts <repo-url> <prompt> [options]");
	console.error("Run with no args to see the full header comment for details.");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
	const client = new Client({ logger: nullLogger });

	const sessionConfig: SessionConfig = {
		repo: { url: repoUrl, ...(commitish ? { commitish } : {}) },
		model: { provider, id: modelId },
		maxIterations,
		...(thinkingEffort ? { thinking: { effort: thinkingEffort } as ThinkingConfig } : {}),
	};

	console.log(`Connecting to ${repoUrl}...`);
	const session = await client.connect(sessionConfig, (msg) => console.error(msg));
	console.log(`Session ${session.id} ready (commit: ${session.repo.commitish})`);
	console.log(`Asking: ${prompt}\n`);

	const signal = abortImmediate ? AbortSignal.abort() : abortMs > 0 ? AbortSignal.timeout(abortMs) : undefined;

	const stream = session.ask(prompt, signal ? { signal } : undefined);

	if (streamMode) {
		for await (const event of stream) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
	} else {
		const result = await stream.result();
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	}

	await session.close();
} catch (err) {
	process.stdout.write(`${JSON.stringify(err, Object.getOwnPropertyNames(err as object), 2)}\n`);
	process.exit(1);
}
