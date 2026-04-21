---
title: Handling Responses
description: Consume real-time stream events and turn results from session.ask().
sidebar:
  order: 3
---

`session.ask()` returns an `AskStream` — an `AsyncIterable<StreamEvent>` with a `.result()` method that reduces the stream into a `TurnResult`.

### Consuming Events

Iterate with `for await...of` to process events as they arrive:

```ts
const stream = session.ask("What does this repo do?");

for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_use_start":
      console.log(`\nUsing tool: ${event.name}`);
      break;
    case "tool_result":
      console.log(`Tool ${event.name} completed in ${event.durationMs}ms`);
      break;
    case "error":
      console.error(`Error: [${event.errorType}] ${event.message}`);
      break;
  }
}
```

### Getting the TurnResult

Call `.result()` to get the reduced `TurnResult`. This works whether or not you iterated the stream:

```ts
// Without iterating — starts and drains the stream internally
const result = await session.ask("What does this repo do?").result();

// After iterating — returns the cached result immediately
const stream = session.ask("What does this repo do?");
for await (const event of stream) { /* ... */ }
const result = await stream.result();
```

### Event Types

#### Turn lifecycle

| Event | Description |
|---|---|
| `turn_start` | Emitted once at the start. Carries `turnId`, `prompt`, `timestamp`. |
| `turn_end` | Emitted once at the end. Carries `metadata` and `usage`. |

#### Content generation

| Event | Description |
|---|---|
| `text_delta` | Streaming chunk of the assistant's visible response text. |
| `text` | Complete text block (emitted after all `text_delta`s for a block). |
| `thinking_delta` | Streaming chunk of the model's internal reasoning (when thinking is enabled). |
| `thinking` | Complete thinking text for the current iteration. |
| `thinking_summary_delta` | Streaming chunk of a thinking summary. |
| `thinking_summary` | Complete thinking summary for the current iteration. |

#### Tool execution

| Event | Description |
|---|---|
| `tool_use_start` | Tool call initiated. `name` is known, arguments not yet streamed. |
| `tool_use_delta` | Streaming chunk of tool argument JSON. |
| `tool_use_end` | Arguments fully parsed in `params`. Tool execution starts. |
| `tool_result` | Tool execution complete. Carries `output`, `isError`, `durationMs`. |

#### Other

| Event | Description |
|---|---|
| `iteration_start` | Marks the start of each LLM inference iteration (zero-based `index`). |
| `compaction` | Context was compacted. Carries `summary`, `tokensBefore`, `tokensAfter`. |
| `error` | Unrecoverable error during the turn. See [Error Handling](/megasthenes/guides/error-handling/). |

### TurnResult Structure

The `TurnResult` is an immutable snapshot of everything that happened in a turn:

```ts
interface TurnResult {
  id: string;                // Unique turn ID
  prompt: string;            // The prompt that started this turn
  steps: readonly Step[];    // Ordered record of everything the agent did
  usage: TokenUsage;         // Token counts across all iterations
  metadata: TurnMetadata;    // Timing, model, config snapshot
  error: { ... } | null;     // Non-null if the turn ended in error
  startedAt: number;         // Epoch ms
  endedAt: number;           // Epoch ms
}
```

Steps include `text`, `thinking`, `thinking_summary`, `tool_call`, `iteration_start`, `compaction`, and `error` records.

### Per-Turn Overrides

Pass `AskOptions` as the second argument to `ask()` to override session-level settings for a single turn:

```ts
// Override the model for one question
const stream = session.ask("Analyze the security of this code", {
  model: { provider: "anthropic", id: "claude-opus-4-6" },
  maxIterations: 30,
  thinking: { type: "adaptive", effort: "high" },
});
```

| Option | Type | Description |
|---|---|---|
| `model` | `ModelConfig` | Override the model for this turn. |
| `maxIterations` | `number` | Override max iterations for this turn. |
| `thinking` | `ThinkingConfig` | Override thinking config for this turn. |
| `afterTurn` | `string` | Branch from after a specific turn ID. See [Multi-turn Conversations](/megasthenes/guides/session-management/). |
| `signal` | `AbortSignal` | Cancel the turn mid-stream. |

### Cancellation

Use an `AbortController` to cancel a turn:

```ts
const controller = new AbortController();
const stream = session.ask("Search the entire codebase for vulnerabilities", {
  signal: controller.signal,
});

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

for await (const event of stream) {
  if (event.type === "error" && event.errorType === "aborted") {
    console.log("Turn was cancelled");
  }
}
```

### Behavior Notes

- **Lazy start**: The stream does not begin until you consume it (iterate or call `.result()`).
- **Single consumption**: A stream can only be iterated once. Attempting to iterate again throws `"AskStream is already being consumed"`.
- **Serialized asks**: Concurrent `ask()` calls on the same session are serialized — each waits for the previous to complete.
- **Cacheable result**: `.result()` can be called multiple times — subsequent calls return the cached `TurnResult`.
