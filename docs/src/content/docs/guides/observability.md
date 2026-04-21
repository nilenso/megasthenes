---
title: Observability
description: Monitor megasthenes sessions with OpenTelemetry tracing.
sidebar:
  order: 7
---

megasthenes instruments session setup and turns with [OpenTelemetry](https://opentelemetry.io/) spans using the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), plus a small set of `megasthenes.*` attributes for repository- and agent-specific details.

The library depends only on `@opentelemetry/api`. If your application does not install and register an OTel SDK, tracing is a no-op.

## Setup

Install the OpenTelemetry SDK and configure a tracer provider **before** creating any sessions:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter()));
provider.register();
```

Once registered, `client.connect(...)` and later `session.ask()` calls automatically emit spans.

## Trace structure

A traced session currently looks like this:

```text
ask
├── connect
│   ├── repo.clone_or_fetch
│   ├── repo.resolve_commitish
│   └── repo.create_worktree
├── ask.turn
│   ├── compaction
│   ├── gen_ai.chat
│   │   └── gen_ai.execute_tool
│   └── gen_ai.chat
└── ask.turn
```

- `ask`: long-lived root span for one connected session
- `connect`: repository setup for that session
- `repo.clone_or_fetch`: local bare clone / fetch / cache reuse
- `repo.resolve_commitish`: commit resolution via `git rev-parse`
- `repo.create_worktree`: worktree creation or reuse
- `ask.turn`: one span per `session.ask()` call
- `compaction`: emitted once per turn, even if no compaction happens
- `gen_ai.chat`: one span per LLM iteration
- `gen_ai.execute_tool`: one span per tool execution

## Span reference

### `ask`

Long-lived root span for a connected session.

**Always includes**
- `megasthenes.repo.url`
- `megasthenes.repo.requested_commitish`
- `megasthenes.connect.mode`
- `megasthenes.session.id` once the session has been created
- `megasthenes.repo.commitish` once the repo has been resolved

Use this span for end-to-end session duration and to correlate setup and later turns in one trace.

### `connect`

Child span for repository setup during `client.connect(...)`.

This span is where local clone/fetch/worktree work or sandbox clone work is recorded.

### `repo.clone_or_fetch`

Local child span covering:
- cache hit / cache reuse
- `git fetch` when the requested commitish is missing locally
- fresh `git clone --bare`

### `repo.resolve_commitish`

Local child span covering `git rev-parse` for the requested commitish.

### `repo.create_worktree`

Local child span covering worktree reuse or `git worktree add`.

### `ask.turn`

Child span for a single `session.ask()` call.

**Always includes**
- `gen_ai.operation.name = "chat"`
- `gen_ai.request.model`
- `megasthenes.session.id`
- `megasthenes.repo.url`
- `megasthenes.repo.commitish`

**Events**
- `gen_ai.system_instructions`
- `gen_ai.input.messages`

**On successful completion**
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `megasthenes.total_iterations`
- `megasthenes.total_tool_calls`

Use this span for turn-level latency, token totals, iteration counts, and overall success/failure.

### `compaction`

Child span covering context compaction before the turn's first generation call.

**Attributes**
- `megasthenes.compaction.was_compacted`
- `megasthenes.compaction.tokens_before` when compaction happens
- `megasthenes.compaction.tokens_after` when compaction happens

This span is emitted even when compaction is skipped, so you can measure how often compaction is considered vs. actually triggered.

### `gen_ai.chat`

Child span for one LLM inference iteration.

**Attributes**
- `gen_ai.operation.name = "chat"`
- `gen_ai.request.model`
- `gen_ai.provider.name`
- `megasthenes.iteration`
- `gen_ai.response.finish_reason` when available
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.cache_read.input_tokens`
- `gen_ai.usage.cache_creation.input_tokens`

**Events**
- `gen_ai.input.messages`
- `gen_ai.output.messages`

Use these spans to inspect per-iteration prompts, responses, stop reasons, and token usage.

### `gen_ai.execute_tool`

Child span for one tool invocation made by the model.

**Attributes**
- `gen_ai.operation.name = "execute_tool"`
- `gen_ai.tool.name`
- `gen_ai.tool.call.id`

**Events**
- `gen_ai.tool.call.arguments`
- `gen_ai.tool.call.result`

Use these spans to measure tool latency and inspect tool arguments/results.

## Error spans

When a span fails, megasthenes records both standard span status and structured error attributes.

**Common error attributes**
- `error.type`
- `megasthenes.error.stage`
- `megasthenes.error.name`
- `megasthenes.error.message`

**Stages**
- `ask`
- `connect`
- `generation`
- `compaction`
- `tool_execution`

`error.type` is aligned with the public API's `ErrorType` values where applicable, so trace queries and programmatic SDK errors use the same vocabulary.

### Error types you may see

| `error.type` | Meaning |
|---|---|
| `aborted` | The turn was aborted after tracing had started |
| `max_iterations` | The turn exhausted its tool-use / generation loop budget |
| `context_overflow` | The provider rejected the prompt because it exceeded the context window |
| `provider_error` | The provider returned a non-specific API error |
| `empty_response` | The model returned no final text content |
| `network_error` | A thrown network-level failure occurred during generation |
| `internal_error` | megasthenes hit an internal failure, or a tool/compaction span failed |

### Typical error shapes

**Provider failure**
- `gen_ai.chat`: `error.type = provider_error`, `megasthenes.error.stage = generation`
- `ask`: `error.type = provider_error`, `megasthenes.error.stage = ask`

**Context overflow**
- `gen_ai.chat`: `error.type = context_overflow`
- `ask`: `error.type = context_overflow`

**Network failure**
- `gen_ai.chat`: `error.type = network_error`
- `ask`: `error.type = network_error`

**Empty final response**
- `gen_ai.chat`: `error.type = empty_response`
- `ask`: `error.type = empty_response`

**Tool failure that the model recovers from**
- `gen_ai.execute_tool`: `error.type = internal_error`, `megasthenes.error.stage = tool_execution`
- later `ask` / `gen_ai.chat` spans may still finish successfully if the model continues

**Compaction failure**
- `compaction`: `error.type = internal_error`, `megasthenes.error.stage = compaction`
- the turn may still continue successfully

## Example failing trace

A provider failure in one turn typically looks like:

```text
ask [OK]
├── connect [OK]
└── ask.turn [ERROR]
    ├── compaction [OK]
    └── gen_ai.chat [ERROR]
```

A tool failure that the model recovers from may look like:

```text
ask [OK]
├── connect [OK]
└── ask.turn [OK]
    ├── compaction [OK]
    ├── gen_ai.chat [OK]
    │   └── gen_ai.execute_tool [ERROR]
    └── gen_ai.chat [OK]
```

## What is currently traced

Today, tracing covers the connected session lifecycle:
- root `ask` session span
- `connect`
- local clone/fetch/rev-parse/worktree spans
- per-turn `ask.turn`
- compaction
- per-iteration generation
- per-tool execution

## Current limitations

The following flows still have gaps:
- sandbox clone tracing is present, but other sandbox lifecycle operations are still less detailed than local git setup
- a turn aborted before its `ask.turn` span starts will not produce a turn span, though the session root span still exists
