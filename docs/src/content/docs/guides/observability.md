---
title: Observability
description: Monitor megasthenes sessions with OpenTelemetry tracing.
sidebar:
  order: 7
---

megasthenes instruments session setup and turns with [OpenTelemetry](https://opentelemetry.io/) spans, following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and adding a small set of `megasthenes.*` attributes for repository- and agent-specific details.

The library depends only on `@opentelemetry/api`. Without a registered OTel SDK, tracing is a no-op.

## Setup

Register an OTel tracer provider **before** creating any sessions:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter()));
provider.register();
```

`client.connect(...)` and `session.ask()` calls will then automatically emit spans.

## Trace structure

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

- `ask` — long-lived root span for one connected session
- `connect` — repository setup
- `repo.clone_or_fetch` — local bare clone, fetch, or cache reuse
- `repo.resolve_commitish` — `git rev-parse` for the requested commitish
- `repo.create_worktree` — worktree reuse or `git worktree add`
- `ask.turn` — one per `session.ask()` call
- `compaction` — emitted once per turn, even when compaction is skipped
- `gen_ai.chat` — one per LLM iteration
- `gen_ai.execute_tool` — one per tool execution

## Span attributes

The `connect` and `repo.*` spans carry only standard span metadata. The spans below add more.

### `ask`

- `megasthenes.repo.url`, `megasthenes.repo.requested_commitish`, `megasthenes.connect.mode`
- `megasthenes.session.id` once the session is created
- `megasthenes.repo.commitish` once the repo is resolved

### `ask.turn`

Attributes: `gen_ai.operation.name = "chat"`, `gen_ai.request.model`, `megasthenes.session.id`, `megasthenes.repo.url`, `megasthenes.repo.commitish`. On successful completion, also `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `megasthenes.total_iterations`, `megasthenes.total_tool_calls`.

Events: `gen_ai.system_instructions`, `gen_ai.input.messages`.

### `compaction`

`megasthenes.compaction.was_compacted`. When compaction actually runs, also `megasthenes.compaction.tokens_before` and `megasthenes.compaction.tokens_after`.

### `gen_ai.chat`

Attributes: `gen_ai.operation.name = "chat"`, `gen_ai.request.model`, `gen_ai.provider.name`, `megasthenes.iteration`, `gen_ai.response.finish_reason` (when available), `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`.

Events: `gen_ai.input.messages`, `gen_ai.output.messages`.

### `gen_ai.execute_tool`

Attributes: `gen_ai.operation.name = "execute_tool"`, `gen_ai.tool.name`, `gen_ai.tool.call.id`.

Events: `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`.

## Errors

When a span fails, megasthenes sets `error.type`, `megasthenes.error.stage` (one of `ask`, `connect`, `generation`, `compaction`, `tool_execution`), `megasthenes.error.name`, and `megasthenes.error.message`. `error.type` aligns with the SDK's public `ErrorType` values so traces and programmatic errors share one vocabulary.

### `error.type` values

| Value | Meaning |
|---|---|
| `aborted` | Turn was aborted after tracing had started |
| `max_iterations` | Turn exhausted its tool-use / generation loop budget |
| `context_overflow` | Provider rejected the prompt for exceeding the context window |
| `provider_error` | Provider returned a non-specific API error |
| `empty_response` | Model returned no final text content |
| `network_error` | Network-level failure during generation |
| `internal_error` | Internal failure, or a tool/compaction span failed |

### Typical shapes

Generation failures originate on `gen_ai.chat` and propagate to the root `ask`. Tool and compaction failures stay local — the turn may still finish successfully.

| Failure | Failing span(s) | `error.type` | `megasthenes.error.stage` |
|---|---|---|---|
| Provider failure | `gen_ai.chat` → `ask` | `provider_error` | `generation` on `gen_ai.chat`; `ask` on the root |
| Context overflow | `gen_ai.chat` → `ask` | `context_overflow` | not set |
| Network failure | `gen_ai.chat` → `ask` | `network_error` | not set |
| Empty final response | `gen_ai.chat` → `ask` | `empty_response` | not set |
| Tool failure | `gen_ai.execute_tool` only | `internal_error` | `tool_execution` |
| Compaction failure | `compaction` only | `internal_error` | `compaction` |

After a failed tool call the model can observe the error and keep going; a failed compaction leaves the turn running on uncompacted context.

### Example trace shapes

Provider failure:

```text
ask [OK]
├── connect [OK]
└── ask.turn [ERROR]
    ├── compaction [OK]
    └── gen_ai.chat [ERROR]
```

Tool failure that the model recovers from:

```text
ask [OK]
├── connect [OK]
└── ask.turn [OK]
    ├── compaction [OK]
    ├── gen_ai.chat [OK]
    │   └── gen_ai.execute_tool [ERROR]
    └── gen_ai.chat [OK]
```

## Limitations

- Sandbox clone tracing exists, but other sandbox lifecycle operations are less detailed than local git setup.
- A turn aborted before its `ask.turn` span starts won't produce a turn span, though the session root span still exists.
