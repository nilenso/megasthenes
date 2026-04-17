---
title: Observability
description: Monitor megasthenes sessions with OpenTelemetry tracing.
sidebar:
  order: 4
---

megasthenes instruments `session.ask()` with [OpenTelemetry](https://opentelemetry.io/) spans using the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), plus a small set of `megasthenes.*` attributes for repository- and agent-specific details.

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

Once registered, every `session.ask()` call automatically emits spans.

## Trace structure

A traced turn currently looks like this:

```text
ask
├── compaction
├── gen_ai.chat
│   ├── gen_ai.execute_tool
│   └── gen_ai.execute_tool
├── gen_ai.chat
└── gen_ai.chat
```

- `ask`: root span for one `session.ask()` call
- `compaction`: emitted once per turn, even if no compaction happens
- `gen_ai.chat`: one span per LLM iteration
- `gen_ai.execute_tool`: one span per tool execution

## Span reference

### `ask`

Root span for a single `session.ask()` call.

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

A provider failure typically looks like:

```text
ask [ERROR]
├── compaction [OK]
└── gen_ai.chat [ERROR]
```

A tool failure that the model recovers from may look like:

```text
ask [OK]
├── compaction [OK]
├── gen_ai.chat [OK]
│   └── gen_ai.execute_tool [ERROR]
└── gen_ai.chat [OK]
```

## What is currently traced

Today, tracing covers the runtime `ask()` path:
- root ask span
- compaction
- per-iteration generation
- per-tool execution

## Current limitations

The following flows are **not** currently traced:
- repository connect / clone / worktree setup
- pre-start aborts that happen before the `ask` span is created

If you need visibility into connection/setup failures, add application-level spans around `client.connect(...)` until megasthenes exposes those directly.
