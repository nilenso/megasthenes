---
title: Getting Started
description: Install and use megasthenes to connect an LLM to a git repository.
sidebar:
  order: 1
---

megasthenes is a TypeScript library that lets you programmatically ask questions to any GitHub or GitLab repository. It connects an LLM to a cloned repo with tools for code search, file reading, and git operations, then returns structured answers with source references.

## Features

- **Ask questions about any repository** — Point it at any public or private repository URL and start asking questions in plain language.
- **Query any point in history** — Pin your question to a specific branch, tag, or commit.
- **Configurable** — Choose any model and provider supported by [pi-ai](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/models.generated.ts) (OpenRouter, Anthropic, Google, and more). Customize the system prompt, tool iteration limits, and context compaction settings.
- **Sandboxed execution** — Run tool execution in an isolated container for exploring untrusted repositories safely.
- **Rich answer metadata** — Every response comes with token usage, inference time, and a list of all the sources the model consulted.
- **OpenTelemetry observability** — All LLM calls and tool invocations are traced with GenAI semantic conventions.

## Requirements

- [Bun](https://bun.sh/) (or Node.js >= 18)
- `git`, `ripgrep`, `fd`
- An LLM API key (set via environment variable, e.g. `OPENROUTER_API_KEY`)

## Installation

```bash
# npm (via JSR)
npx jsr add @nilenso/megasthenes

# Bun
bunx jsr add @nilenso/megasthenes
```

## Quick Start

```ts
import { Client } from "@nilenso/megasthenes";

const client = new Client({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4-20250514",
});

const session = await client.connect("https://github.com/owner/repo");

const result = await session.ask("What does this repo do?");
console.log(result.response);       // The LLM's answer
console.log(result.toolCalls);      // Tools invoked (rg, fd, read, etc.)
console.log(result.invalidLinks);   // Any invalid links detected

// Every subsequent call to `session.ask()` continues the
// conversation with full context
await session.ask("Tell me more about how the tests are structured");
```
