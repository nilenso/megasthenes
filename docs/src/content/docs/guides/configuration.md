---
title: Configuration
description: Configure the model provider, system prompt, sandbox, and other settings.
sidebar:
  order: 2
---

### Connect Options

The `connect()` method accepts git-related options:

```ts
// Connect to a specific commit, branch, or tag
const session = await client.connect("https://github.com/owner/repo", {
  commitish: "v1.0.0",
});

// Connect to a private repository with a token
const session = await client.connect("https://github.com/owner/repo", {
  token: process.env.GITHUB_TOKEN,
});

// Explicitly specify the forge (auto-detected for github.com and gitlab.com)
const session = await client.connect("https://gitlab.example.com/owner/repo", {
  forge: "gitlab",
  token: process.env.GITLAB_TOKEN,
});
```

### Model and Provider

The `Client` accepts a `ForgeConfig` object that controls the AI model and behavior.

By default, the client uses **OpenRouter** with **`anthropic/claude-sonnet-4.6`**. You can override both `provider` and `model` (they must be specified together). The corresponding API key environment variable is resolved automatically (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`).

Available providers and model IDs are defined in [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/models.generated.ts).

```ts
import { Client, type ForgeConfig } from "@nilenso/megasthenes";

// Use defaults (openrouter + anthropic/claude-sonnet-4.6)
const client = new Client();

// Or specify a different provider/model
const client = new Client({
  provider: "anthropic",
  model: "claude-sonnet-4.6",
});

// Full configuration
const client = new Client({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.6",
  maxIterations: 10,                    // Optional: default is 20
});
```

### System Prompt

By default, megasthenes builds a system prompt that includes the repository URL and commit SHA. You can override it to customize the assistant's behavior:

```ts
const client = new Client({
  systemPrompt: "You are a security auditor. Focus on identifying vulnerabilities, insecure patterns, and potential attack vectors in the codebase.",
});
```

You can also build the default prompt yourself and extend it:

```ts
import { Client, buildDefaultSystemPrompt } from "@nilenso/megasthenes";

const base = buildDefaultSystemPrompt("https://github.com/owner/repo", "abc123");
const client = new Client({
  systemPrompt: `${base}\n\nAlways respond in Spanish.`,
});
```

### Logging

The second parameter to the constructor controls logging:

```ts
import {
  Client,
  consoleLogger,
  nullLogger,
  type Logger,
} from "@nilenso/megasthenes";

// Use console logger (default)
const client = new Client(config, consoleLogger);

// Silence all logging
const client = new Client(config, nullLogger);

// Custom logger
const customLogger: Logger = {
  log: (label, content) => myLogSystem.info(`${label}: ${content}`),
  error: (label, error) => myLogSystem.error(label, error),
};
const client = new Client(config, customLogger);
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

Control the model's reasoning/thinking behavior via the `thinking` field. Megasthenes supports two modes:

- **Effort-based** (cross-provider): Set an effort level that pi-ai maps to each provider's native format (`reasoning.effort` for OpenAI, `thinking` for Anthropic, etc.)
- **Adaptive** (Anthropic 4.6 only): The model decides when and how much to think per request

```ts
// OpenAI — effort-based reasoning
const client = new Client({
  provider: "openai",
  model: "o3",
  thinking: { effort: "low" },
});

// Anthropic 4.5 — effort-based (older model, no adaptive support)
const client = new Client({
  provider: "anthropic",
  model: "claude-sonnet-4-5-20251022",
  thinking: { effort: "high", budgetOverrides: { high: 10000 } },
});

// Anthropic 4.6 — adaptive (model decides when/how much to think)
const client = new Client({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinking: { type: "adaptive" },
});

// Anthropic 4.6 — adaptive with explicit effort guidance
const client = new Client({
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinking: { type: "adaptive", effort: "medium" },
});

// No thinking (default)
const client = new Client();
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"adaptive"` | Anthropic 4.6 only. Omit for effort-based mode. |
| `effort` | `"minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | Required for effort-based, optional for adaptive. |
| `budgetOverrides` | `ThinkingBudgets` | Custom token budgets per level (effort-based only). |

### Context Compaction

When conversations grow long, megasthenes can automatically summarize older messages to stay within the model's context window. This is enabled by default.

```ts
const client = new Client({
  compaction: {
    enabled: true,            // default: true
    contextWindow: 200_000,   // default: 200K tokens
    reserveTokens: 16_384,    // tokens reserved for the response
    keepRecentTokens: 20_000, // recent messages to keep unsummarized
  },
});
```

### Tracing

megasthenes emits [OpenTelemetry](https://opentelemetry.io/) spans following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). The library depends only on `@opentelemetry/api` — if no OTel SDK is installed, all tracing is a zero-overhead no-op.

To send traces to any OTel-compatible backend (Jaeger, Honeycomb, Langfuse, etc.):

1. Install `@opentelemetry/sdk-node` and your backend's exporter or span processor
2. Create and start a `NodeSDK` instance **before** creating any `Client`
3. All `session.ask()` calls will automatically emit spans to your backend

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

See the [Observability guide](/megasthenes/guides/observability/) for the full trace structure and captured metrics.

### Streaming Progress

Use the `onProgress` callback to receive real-time events during inference:

```ts
const result = await session.ask("Find all API endpoints", {
  onProgress: (event) => {
    switch (event.type) {
      case "tool_call":
        console.log(`Using tool: ${event.name}`);
        break;
      case "text_delta":
        process.stdout.write(event.text);
        break;
    }
  },
});
```
