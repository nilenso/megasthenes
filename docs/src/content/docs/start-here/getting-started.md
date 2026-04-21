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
- **Configurable** — Choose any model and provider supported by [pi-ai](https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts) (OpenRouter, Anthropic, Google, and more). Customize the system prompt, tool iteration limits, and context compaction settings.
- **Sandboxed execution** — Run tool execution in an isolated container for exploring untrusted repositories safely.
- **Rich answer metadata** — Every response includes token usage, timing, and a complete record of all tool calls the model made.
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

Install system dependencies:

```bash
# macOS
brew install git ripgrep fd

# Debian / Ubuntu
sudo apt install -y git ripgrep fd-find

# Fedora
sudo dnf install -y git ripgrep fd-find

# Arch
sudo pacman -S --noconfirm git ripgrep fd
```

## Quick Start

```ts
import { Client } from "@nilenso/megasthenes";

const client = new Client();
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" },
  maxIterations: 20,
});

// Stream events as they arrive
const stream = session.ask("What does this repo do?");
for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

// Or wait for the complete result
const result = await session.ask("How are the tests structured?").result();
console.log(result.steps);   // All steps: text, tool calls, thinking, etc.
console.log(result.usage);   // Token usage across all iterations

await session.close();
```
