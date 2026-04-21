---
title: Configuration
description: Configure sessions — connect options, system prompt, logging, sandbox, thinking, compaction, and tracing.
sidebar:
  order: 1
---

Megasthenes has two layers of configuration:

- **`ClientConfig`** — shared infrastructure. Passed to `new Client(clientConfig)`. Holds `sandbox` and `logger`.
- **`SessionConfig`** — per-session behavior. Passed to `client.connect(sessionConfig)`. Holds `repo`, `model`, `maxIterations`, `systemPrompt`, `thinking`, `compaction`, and the restoration fields `initialTurns` / `lastCompactionSummary`.

For model/provider selection and per-ask overrides, see [API Keys and Providers](/megasthenes/guides/api-keys-and-providers/).

### Connect Options (repo)

`connect()` takes a `SessionConfig` object. The `repo` field controls how the repository is fetched:

```ts
// Connect to a specific commit, branch, or tag
await client.connect({
  repo: { url: "https://github.com/owner/repo", commitish: "v1.0.0" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// Connect to a private repository with a token
await client.connect({
  repo: {
    url: "https://github.com/owner/repo",
    token: process.env.GITHUB_TOKEN,
  },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// Explicitly specify the forge (auto-detected for github.com and gitlab.com)
await client.connect({
  repo: {
    url: "https://gitlab.example.com/owner/repo",
    forge: "gitlab",
    token: process.env.GITLAB_TOKEN,
  },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});
```

### Consuming `ask()` results

`session.ask(prompt, options?)` returns an `AskStream` — an `AsyncIterable<StreamEvent>` that also exposes `.result()` for the reduced `TurnResult`. There is no `onProgress` callback; consume by iterating or awaiting the result:

```ts
// Stream events as they arrive
for await (const event of session.ask("What does this repo do?")) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

// Or await the full reduced result
const result = await session.ask("How are the tests structured?").result();
```

For the full event reference and consumption patterns (mixing iteration with `.result()`, error events, tool events, compaction events), see [Handling Responses](/megasthenes/guides/streaming/).

### Per-turn overrides

`ask(prompt, options)` accepts an `AskOptions` object for per-turn behavior. Model and thinking overrides are covered in [API Keys and Providers](/megasthenes/guides/api-keys-and-providers/#per-ask-override). Other fields:

- `maxIterations` — override the iteration cap for this turn.
- `afterTurn` — branch from a specific turn. See [Conversations — Conversation Branching](/megasthenes/guides/session-management/#conversation-branching).
- `signal` — an `AbortSignal` to cancel the turn mid-stream.

See [`AskOptions`](/megasthenes/api/interfaces/askoptions/) for the full interface.

### System Prompt

By default, megasthenes builds a system prompt that embeds the repository URL and commit SHA. Override it per session to customize behavior:

```ts
await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  systemPrompt:
    "You are a security auditor. Focus on identifying vulnerabilities, insecure patterns, and potential attack vectors.",
});
```

You can also build the default prompt yourself and extend it:

```ts
import { Client, buildDefaultSystemPrompt } from "@nilenso/megasthenes";

const base = buildDefaultSystemPrompt("https://github.com/owner/repo", "abc123");

await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  systemPrompt: `${base}\n\nAlways respond in Spanish.`,
});
```

### Logging

The `logger` field on `ClientConfig` controls logging for all sessions opened by that client:

```ts
import {
  Client,
  consoleLogger,
  nullLogger,
  type Logger,
} from "@nilenso/megasthenes";

// Default — consoleLogger
const client = new Client();

// Silence all logging
const client = new Client({ logger: nullLogger });

// Custom logger
const customLogger: Logger = {
  log: (label, content) => myLogSystem.info(`${label}: ${content}`),
  error: (label, error) => myLogSystem.error(label, error),
};
const client = new Client({ logger: customLogger });
```

### Sandboxing

For production deployments or untrusted repositories, enable sandbox mode to run all operations in an isolated container:

```ts
const client = new Client({
  sandbox: {
    baseUrl: "http://localhost:8080",
    timeoutMs: 120_000,
    secret: "optional-auth-secret",
  },
});
```

When enabled, repository cloning and all tool execution (file reads, searches, git operations) happen inside the sandbox. The host filesystem is never accessed directly.

See the [Sandboxed Execution guide](/megasthenes/guides/sandbox/) for security layers, architecture, and how to run the sandbox server.

### Thinking

Control the model's reasoning behavior via the `thinking` field on `SessionConfig`. Megasthenes supports two modes:

- **Effort-based** (cross-provider): Set an effort level that pi-ai maps to each provider's native format (`reasoning.effort` for OpenAI, `thinking` for Anthropic, etc.).
- **Adaptive** (Anthropic 4.6 only): The model decides when and how much to think per request.

```ts
// OpenAI — effort-based reasoning
await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "openai", id: "o3" },
  maxIterations: 20,
  thinking: { effort: "low" },
});

// Anthropic 4.5 — effort-based (older model, no adaptive support)
await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-5-20251022" },
  maxIterations: 20,
  thinking: { effort: "high", budgetOverrides: { high: 10000 } },
});

// Anthropic 4.6 — adaptive (model decides when/how much to think)
await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  thinking: { type: "adaptive" },
});

// Anthropic 4.6 — adaptive with explicit effort guidance
await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
  thinking: { type: "adaptive", effort: "medium" },
});
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"adaptive"` | Anthropic 4.6 only. Omit for effort-based mode. |
| `effort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Required for effort-based, optional for adaptive. |
| `budgetOverrides` | `ThinkingBudgets` | Custom token budgets per level (effort-based only). |

Thinking can also be overridden per `ask()` — see [API Keys and Providers](/megasthenes/guides/api-keys-and-providers/#per-ask-override).

### Context Compaction

When conversations grow long, megasthenes automatically summarizes older messages to stay within the model's context window. Compaction is enabled by default.

### Tracing

megasthenes emits [OpenTelemetry](https://opentelemetry.io/) spans following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). The library depends only on `@opentelemetry/api` — if no OTel SDK is installed, all tracing is a zero-overhead no-op.

To send traces to any OTel-compatible backend (Jaeger, Honeycomb, Langfuse, etc.):

1. Install `@opentelemetry/sdk-node` and your backend's exporter or span processor
2. Create and start a `NodeSDK` instance **before** creating any `Client`
3. All `session.ask()` calls will automatically emit spans to your backend

Tracing currently covers the connected session lifecycle. The main spans emitted today are:
- `ask`
- `connect`
- `repo.clone_or_fetch`
- `repo.resolve_commitish`
- `repo.create_worktree`
- `ask.turn`
- `compaction`
- `gen_ai.chat`
- `gen_ai.execute_tool`

#### Console (development)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

const sdk = new NodeSDK({ traceExporter: new ConsoleSpanExporter() });
sdk.start();
```

#### Langfuse

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});
sdk.start();
```

See the [Observability guide](/megasthenes/guides/observability/) for the full span hierarchy, emitted attributes/events, and structured error tracing.
