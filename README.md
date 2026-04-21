# Megasthenes

[![CI](https://github.com/nilenso/megasthenes/actions/workflows/ci.yml/badge.svg)](https://github.com/nilenso/megasthenes/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@nilenso/megasthenes)](https://jsr.io/@nilenso/megasthenes)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?logo=bun&logoColor=black)](https://bun.sh/)

Megasthenes allows you to programmatically ask questions to a GitHub/GitLab repository.

> **Why "Megasthenes"?**
>
> Megasthenes was a Greek ambassador sent to the Maurya court around 300 BCE. He spent years in an unfamiliar land, observed carefully, and wrote *Indica* — one of the first detailed accounts of the Indian subcontinent by an outsider. Not a tourist's diary, but a structured report: governance, geography, trade routes, how things actually worked.
>
> This library does something similar with codebases. You drop it into a repository it has never seen, and it pokes around — reads files, greps for patterns, walks the git history — until it can give you a coherent, sourced answer about what's in there.

## Features

- 🔗 **Ask questions about any GitHub/GitLab repository**: Point it at any public or private repository URL and start asking questions in plain language.
- 📌 **Query any point in history**: Pin your question to a specific branch, tag, or commit
- 🤖 **Configurable**: Choose any model and provider supported by [`pi-ai`](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/models.generated.ts) (OpenRouter, Anthropic, Google, and more). Customize the system prompt, tool iteration limits, and context compaction settings.
- 🔒 **Sandboxed execution**: Run tool execution (file reads, code search) in an isolated container for exploring untrusted repositories safely
- 📊 **Rich answer metadata**: Every response includes token usage, timing, and a complete record of all tool calls the model made.
- 📡 **OpenTelemetry observability**: Built-in tracing with GenAI semantic conventions — send spans to Langfuse, Jaeger, or any OTel-compatible backend. Zero overhead when no SDK is installed.
- 🧪 **Built-in evaluation system**: Measure and track answer quality over time using an LLM judge that scores responses on completeness, evidence, sourcing, and reasoning.

## Documentation

Full documentation is available at [nilenso.github.io/megasthenes](https://nilenso.github.io/megasthenes/) — configuration, sandboxing, observability, error handling, and the API reference.

## Requirements

- [Bun](https://bun.sh/) (or Node.js ≥ 18)
- `git`
- `ripgrep`
- `fd`
- An LLM API key (set via environment variable, e.g. `OPENROUTER_API_KEY`)

## Installation

```bash
# Using JSR (recommended)
bunx jsr add @nilenso/megasthenes

# Or with npx
npx jsr add @nilenso/megasthenes
```

For Docker or manual setup, add to `package.json`:
```json
"@nilenso/megasthenes": "npm:@jsr/nilenso__megasthenes@0.0.19"
```

And create `.npmrc`:
```
@jsr:registry=https://npm.jsr.io
```

## Usage

```typescript
import { Client } from "@nilenso/megasthenes";

const client = new Client();
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// Stream events as they arrive
const stream = session.ask("What frameworks does this project use?");
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

// Or wait for the complete result
const result = await session.ask("How are the tests structured?").result();
console.log(result.steps);   // All steps: text, tool calls, thinking, etc.
console.log(result.usage);   // Token usage across all iterations

await session.close();
```

For configuration, sandboxing, observability, and the full API reference, see the [documentation](https://nilenso.github.io/megasthenes/).