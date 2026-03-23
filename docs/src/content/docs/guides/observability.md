---
title: Observability
description: Monitor ask-forge sessions with OpenTelemetry tracing.
sidebar:
  order: 4
---

ask-forge instruments all LLM interactions with [OpenTelemetry](https://opentelemetry.io/) spans following the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

### Setup

Install the OpenTelemetry SDK and configure a tracer provider before creating sessions:

```ts
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new SimpleSpanProcessor(new OTLPTraceExporter())
);
provider.register();
```

Once registered, all `session.ask()` calls automatically emit spans.

### Trace Structure

```
ask_forge.session.ask
├── gen_ai.chat (per LLM call)
│   └── gen_ai.tool_call (per tool invocation)
├── gen_ai.chat
│   └── gen_ai.tool_call
└── ...
```

### Captured Attributes

| Attribute | Description |
|---|---|
| `gen_ai.system` | Model provider name |
| `gen_ai.request.model` | Model identifier |
| `gen_ai.response.model` | Model returned in response |
| `gen_ai.response.finish_reasons` | Why the model stopped |
| `gen_ai.usage.input_tokens` | Prompt token count |
| `gen_ai.usage.output_tokens` | Completion token count |
| `ask_forge.iteration.count` | Number of tool-use iterations |
| `ask_forge.tool_call.count` | Total tool calls in the session |
| `ask_forge.repo.url` | Repository URL |
