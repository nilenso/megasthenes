# Ask Forge

[![CI](https://github.com/nilenso/ask-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/nilenso/ask-forge/actions/workflows/ci.yml)
[![JSR](https://jsr.io/badges/@nilenso/ask-forge)](https://jsr.io/@nilenso/ask-forge)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-runtime-f9f1e1?logo=bun&logoColor=black)](https://bun.sh/)

Ask Forge allows you to programmatically ask questions to a GitHub/GitLab repository.

## Features

- 🔗 **Ask questions about any GitHub/GitLab repository**: Point it at any public or private repository URL and start asking questions in plain language.
- 📌 **Query any point in history**: Pin your question to a specific branch, tag, or commit
- 🤖 **Configurable**: Choose any model and provider supported by [`pi-ai`](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/models.generated.ts) (OpenRouter, Anthropic, Google, and more). Customize the system prompt, tool iteration limits, and context compaction settings.
- 🔒 **Sandboxed execution**: Run tool execution (file reads, code search) in an isolated container for exploring untrusted repositories safely
- 📊 **Rich answer metadata**: Every response comes with token usage, inference time, and a list of all the sources the model consulted to form its answer.
- 📡 **OpenTelemetry observability**: Built-in tracing with GenAI semantic conventions — send spans to Langfuse, Jaeger, or any OTel-compatible backend. Zero overhead when no SDK is installed.
- 🧪 **Built-in evaluation system**: Measure and track answer quality over time using an LLM judge that scores responses on completeness, evidence, sourcing, and reasoning.

## Requirements

- [Bun](https://bun.sh/) (or Node.js ≥ 18)
- `git`
- `ripgrep`
- `fd`
- An LLM API key (set via environment variable, e.g. `OPENROUTER_API_KEY`)

## Installation

```bash
# Using JSR (recommended)
bunx jsr add @nilenso/ask-forge

# Or with npx
npx jsr add @nilenso/ask-forge
```

For Docker or manual setup, add to `package.json`:
```json
"@nilenso/ask-forge": "npm:@jsr/nilenso__ask-forge@0.0.7"
```

And create `.npmrc`:
```
@jsr:registry=https://npm.jsr.io
```

## Usage

```typescript
import { AskForgeClient } from "@nilenso/ask-forge";

// Create a client (defaults to openrouter with claude-sonnet-4.6)
const client = new AskForgeClient();

// Connect to a repository
const session = await client.connect("https://github.com/owner/repo");

// Ask a question
const result = await session.ask("What frameworks does this project use?");
console.log(result.response);

// Clean up when done
session.close();
```

For configuration, sandboxing, observability, and the full API reference, see the [documentation](https://nilenso.github.io/ask-forge/).
