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

### AskForgeClient

The `AskForgeClient` class holds your configuration and can create multiple sessions:

```typescript
import { AskForgeClient } from "@nilenso/ask-forge";

const client = new AskForgeClient(); // Uses defaults

// Connect to multiple repositories with the same config
const session1 = await client.connect("https://github.com/owner/repo1");
const session2 = await client.connect("https://github.com/owner/repo2");

// In sandbox mode, reset all cloned repos
await client.resetSandbox();
```

### Configuration

The `ForgeConfig` object controls the AI model and behavior.

By default, the client uses **OpenRouter** with **`anthropic/claude-sonnet-4.6`**. You can override both `provider` and `model` (they must be specified together). The corresponding API key environment variable is resolved automatically (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`).

Available providers and model IDs are defined in [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/blob/main/packages/pi-ai/src/models.generated.ts).

```typescript
import { AskForgeClient, type ForgeConfig } from "@nilenso/ask-forge";

// Use defaults (openrouter + anthropic/claude-sonnet-4.6)
const client = new AskForgeClient();

// Or specify a different provider/model
const client = new AskForgeClient({
  provider: "anthropic",
  model: "claude-sonnet-4.6",
});

// Full configuration
const client = new AskForgeClient({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.6",
  systemPrompt: "Custom prompt...",    // Optional: has a built-in default
  maxIterations: 10,                   // Optional: default is 20
  sandbox: {                           // Optional: enable sandboxed execution
    baseUrl: "http://sandbox:8080",
    timeoutMs: 120_000,
    secret: "optional-auth-secret",
  },
});
```

### Connect Options

The `connect()` method accepts git-related options:

```typescript
import { AskForgeClient, type ForgeConfig, type ConnectOptions } from "@nilenso/ask-forge";

const client = new AskForgeClient(config);

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

### Custom Logger

The second parameter to the constructor controls logging:

```typescript
import { AskForgeClient, consoleLogger, nullLogger, type Logger, type ForgeConfig } from "@nilenso/ask-forge";

// Use console logger (default)
const client = new AskForgeClient(config, consoleLogger);

// Silence all logging
const client = new AskForgeClient(config, nullLogger);

// Custom logger
const customLogger: Logger = {
  log: (label, content) => myLogSystem.info(`${label}: ${content}`),
  error: (label, error) => myLogSystem.error(label, error),
};
const client = new AskForgeClient(config, customLogger);
```

### Ask Result

```typescript
import { AskForgeClient, type ForgeConfig, type AskResult } from "@nilenso/ask-forge";

const client = new AskForgeClient(config);
const session = await client.connect("https://github.com/owner/repo");
const result: AskResult = await session.ask("Explain the auth flow");

console.log(result.prompt);          // Original question
console.log(result.response);        // Final response text
console.log(result.toolCalls);       // List of tools used: { name, arguments }[]
console.log(result.inferenceTimeMs); // Total inference time in ms
console.log(result.usage);           // Token usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }
```

### Streaming Progress

Use the `onProgress` callback to receive real-time events during inference:

```typescript
import { AskForgeClient, type ForgeConfig, type ProgressEvent, type OnProgress } from "@nilenso/ask-forge";

const client = new AskForgeClient(config);
const session = await client.connect("https://github.com/owner/repo");

const onProgress: OnProgress = (event: ProgressEvent) => {
  switch (event.type) {
    case "thinking":
      console.log("Model is thinking...");
      break;
    case "thinking_delta":
      process.stdout.write(event.delta); // Streaming reasoning
      break;
    case "text_delta":
      process.stdout.write(event.delta); // Streaming response text
      break;
    case "tool_start":
      console.log(`Calling tool: ${event.name}`);
      break;
    case "tool_end":
      console.log(`Tool ${event.name} completed`);
      break;
    case "responding":
      console.log("Final response ready");
      break;
  }
};

const result = await session.ask("How does authentication work?", { onProgress });
```

### Session Management

Sessions maintain conversation history for multi-turn interactions:

```typescript
import { AskForgeClient, type ForgeConfig, type Session, type Message } from "@nilenso/ask-forge";

const client = new AskForgeClient(config);
const session: Session = await client.connect("https://github.com/owner/repo");

// Session properties
console.log(session.id);              // Unique session identifier
console.log(session.repo.url);        // Repository URL
console.log(session.repo.localPath);  // Local worktree path
console.log(session.repo.commitish);  // Resolved commit SHA

// Multi-turn conversation
await session.ask("What is this project?");
await session.ask("Tell me more about the auth module"); // Has context from first question

// Access conversation history
const messages: Message[] = session.getMessages();

// Restore a previous conversation
session.replaceMessages(savedMessages);

// Clean up (removes git worktree)
session.close();
```


## Sandboxed Execution

For production deployments, Ask Forge can run tool execution in an isolated container. Enable sandbox mode by adding the `sandbox` field to your config:

```typescript
import { AskForgeClient, type ForgeConfig } from "@nilenso/ask-forge";

const client = new AskForgeClient({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.6",
  systemPrompt: "You are a code analysis assistant.",
  maxIterations: 20,

  // Enable sandboxed execution
  sandbox: {
    baseUrl: "http://sandbox:8080",  // Sandbox worker URL
    timeoutMs: 120_000,              // Request timeout
    secret: "optional-auth-secret",  // Optional auth token
  },
});

// All operations (clone + tool execution) now run in the sandbox
const session = await client.connect("https://github.com/owner/repo");
```

### Security Layers

| Layer | Mechanism | Protection |
|-------|-----------|------------|
| 1 | bwrap (bubblewrap) | Filesystem and PID namespace isolation |
| 2 | seccomp BPF | Blocks network socket creation for tools |
| 3 | gVisor (optional) | Kernel-level syscall sandboxing |
| 4 | Path validation | Prevents directory traversal attacks |

### Architecture

```
src/sandbox/
├── client.ts          # HTTP client for the sandbox worker
├── worker.ts          # HTTP server (runs in container)
├── Containerfile
└── isolation/         # Security primitives
    ├── index.ts       # bwrap + seccomp wrappers
    └── seccomp/       # BPF filter sources (C)
```

### Running the Sandbox

**Prerequisites:**

1. [Install gVisor](https://gvisor.dev/docs/user_guide/install/) and register the `runsc` runtime with your container engine.

2. **Podman** requires two extra configuration steps for gVisor:

   - Register `runsc` as a runtime in `/etc/containers/containers.conf`:
     ```ini
     [engine.runtimes]
     runsc = ["/usr/local/bin/runsc"]
     ```
     If running rootful (recommended for gVisor), do **not** include `--rootless=true`.

   - Use `--in-pod=false` — podman-compose creates a pod by default whose infra container uses the default runtime (`crun`), which conflicts with gVisor. The justfile already handles this.

   **Docker** works out of the box with `runtime: runsc` — no extra configuration needed.

```bash
# Using just (recommended) — requires sudo for gVisor
sudo just sandbox-up        # Build & start container
sudo just sandbox-down      # Stop container
sudo just sandbox-logs      # View logs

# Or manually with podman (rootful)
sudo podman-compose --in-pod=false up -d

# Or with docker compose
docker compose up -d
```

### HTTP API

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/health` | GET | — | Liveness check |
| `/clone` | POST | `{ url, commitish? }` | Clone repo and checkout commit |
| `/tool` | POST | `{ slug, sha, name, args }` | Execute tool (rg, fd, ls, read, git) |
| `/reset` | POST | — | Delete all cloned repos |

### Testing the Sandbox

```bash
just isolation-tests     # Test bwrap + seccomp (runs on host)
just sandbox-tests       # Test HTTP API + security (runs against container)
just sandbox-all-tests   # Run both
```


## Observability

Ask Forge emits [OpenTelemetry](https://opentelemetry.io/) spans following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). The library depends only on `@opentelemetry/api` — if no OTel SDK is installed, all tracing is a zero-overhead no-op.

### Setup

Install an OTel SDK and configure an exporter. Ask Forge spans will flow to any backend automatically.

```typescript
// Example: send traces to Langfuse
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});
sdk.start();

// That's it — ask-forge spans now appear in Langfuse
const client = new AskForgeClient();
const session = await client.connect("https://github.com/owner/repo");
await session.ask("What frameworks does this project use?");
```

### Trace Structure

Each `ask()` call produces a trace with the following span tree:

```
ask (root)
├── compaction
├── gen_ai.chat (iteration 1)
├── gen_ai.execute_tool (rg)
├── gen_ai.execute_tool (read)
├── gen_ai.chat (iteration 2)
└── gen_ai.chat (iteration 3, final response)
```

### Captured Metrics

| Span | Attributes | Events |
|------|-----------|--------|
| **`ask`** (root) | `gen_ai.operation.name`, `gen_ai.request.model`, `ask_forge.session.id`, `ask_forge.repo.url`, `ask_forge.repo.commitish`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `ask_forge.total_iterations`, `ask_forge.total_tool_calls`, `ask_forge.response.total_links`, `ask_forge.response.invalid_links` | `gen_ai.system_instructions` (system prompt content) |
| **`compaction`** | `ask_forge.compaction.was_compacted`, `ask_forge.compaction.tokens_before`, `ask_forge.compaction.tokens_after` | Exception recorded on error |
| **`gen_ai.chat`** | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `ask_forge.iteration`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.response.finish_reason` | `gen_ai.input.messages` (full LLM context), `gen_ai.output.messages` (response content). Exception recorded on error with full stack trace. |
| **`gen_ai.execute_tool`** | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id` | `gen_ai.tool.call.arguments` (tool input), `gen_ai.tool.call.result` (tool output, including file contents for `read` tool) |

### Error Handling

All error paths record exceptions with full stack traces via `span.recordException()`:
- Stream errors during LLM calls
- API errors (`stopReason === "error"`)
- Max iterations exceeded (`error.type = "max_iterations_reached"`)
- Compaction failures

## Development

### Running from source

```bash
bun install
bun run scripts/ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

The CLI uses settings from `src/config.ts` (model, system prompt, etc.).

### Testing

```bash
just test               # Run all unit tests
just isolation-tests    # Test security isolation (bwrap + seccomp)
just sandbox-tests      # Test sandbox HTTP API
just sandbox-all-tests  # Run all sandbox tests
```

### Evaluation

The `scripts/eval/` folder contains an evaluation system that asks questions against repositories and uses an LLM judge to score the answers on relevance, evidence support, and evidence linking.

#### Dataset

The eval dataset is hosted on HuggingFace: [nilenso/ask-forge-eval-dataset](https://huggingface.co/datasets/nilenso/ask-forge-eval-dataset)

Download and convert it to CSV using the HuggingFace CLI:

```bash
# Install the HuggingFace CLI (if not already installed)
pip install huggingface-hub[cli]

# Download the dataset
huggingface-cli download nilenso/ask-forge-eval-dataset --repo-type dataset --local-dir ./eval-data

# Convert the parquet file to CSV
pip install pandas pyarrow
python3 -c "import pandas as pd; pd.read_parquet('./eval-data/data/train-00000-of-00001.parquet').to_csv('./eval-dataset.csv', index=False)"
```

The CSV must have these columns:
- `repository` — Git URL of the repository
- `commit_id` — Commit SHA to checkout
- `question` — Question to ask
- `id` or `session_id` — Row identifier

#### Running the eval

```bash
bun run scripts/eval/run-eval.ts ./eval-dataset.csv
```

Results are written to `scripts/eval/reports/` as a CSV with per-row verdicts. The judge evaluates each answer on four criteria:

| Criterion | Description |
|-----------|-------------|
| `is_answer_complete` | Does the answer address every aspect of the question? |
| `is_evidence_supported` | Are repository-specific claims backed by evidence? |
| `is_evidence_linked` | Are code references linked with valid GitHub/GitLab URLs with line anchors? |
| `is_reasoning_sound` | Are conclusions internally consistent and supported by cited evidence? |

#### Viewing results

Open `scripts/eval/eval-viewer.html` in a browser to visualise eval results.

**Single run:** Drag and drop a results CSV into the "Current Run" zone and click "View Report" to browse questions, answers, verdicts, tool calls, and broken link ratios.

**Comparing runs:** Drag a previous run CSV into the "Previous Run" zone as well. The viewer highlights regressions, improvements, and structural differences between the two runs side by side.
