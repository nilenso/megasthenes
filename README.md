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
