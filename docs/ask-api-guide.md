# `ask()` API Usage Guide

This guide walks through how to use the `ask()` API with practical examples. For type definitions and behavioral contracts, see the [API Specification](./ask-api-redesign.md).

---

## Getting Started

### Create a Client

The client holds shared infrastructure -- transport, sandboxing, logging. No model config here.

```typescript
import { AskForgeClient } from "askforge";

const client = new AskForgeClient({
  sandbox: { /* ... */ },
  logger: console,
});
```

### Connect to a Repository

Each session declares its own model and behavioral config. This is where you choose the model, thinking strategy, and iteration limits.

```typescript
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo", token: process.env.GITHUB_TOKEN },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinking: { type: "adaptive", effort: "high" },
  maxIterations: 15,
  compaction: { enabled: true, contextWindow: 200_000 },
});
```

The session is now bound to the repository and ready to accept questions.

### Multiple Sessions with Different Models

A single client can power sessions with different models -- useful for multi-agent architectures.

```typescript
const planner = await client.connect({
  repo: { url: "https://github.com/owner/repo", token: process.env.GITHUB_TOKEN },
  model: { provider: "anthropic", id: "claude-opus-4-6" },
  thinking: { type: "adaptive", effort: "high" },
  maxIterations: 30,
});

const executor = await client.connect({
  repo: { url: "https://github.com/owner/repo", token: process.env.GITHUB_TOKEN },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 15,
});

// Planner decides what to do, executor carries it out
const plan = await planner.ask("What needs to change to add OAuth support?").result();
const result = await executor.ask(plan.text).result();
```

---

## Basic Usage Patterns

The `ask()` method returns an `AskStream` -- an async iterable that can also be reduced to a final `TurnResult`. This gives you two ways to consume results.

### Pattern 1: Simple (Non-Streaming)

The simplest way to use the API. Call `.result()` to await the final answer.

```typescript
const result = await session.ask("What does this repo do?").result();

console.log(result.text);       // the model's response
console.log(result.error);      // null if successful
console.log(result.toolCalls);  // tools the model used
```

### Pattern 2: Streaming

Iterate the stream to get real-time events as the model thinks, writes, and uses tools.

```typescript
const stream = session.ask("Explain the auth module");

for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_use_start":
      console.log(`\nCalling ${event.name}...`);
      break;
    case "tool_result":
      console.log(`${event.name} done (${event.durationMs}ms)`);
      break;
  }
}

// After iteration, get the complete result
const result = await stream.result();
console.log(`\nTokens used: ${result.usage.totalTokens}`);
```

---

## Working with Stream Events

### Showing Model Thinking

When thinking is enabled, you can display the model's reasoning process in real time.

```typescript
const stream = session.ask("Find potential security issues in the auth flow");

for await (const event of stream) {
  switch (event.type) {
    case "thinking_delta":
      // Stream thinking to a debug panel or separate UI element
      debugPanel.append(event.delta);
      break;
    case "thinking":
      // Or wait for the complete thinking block
      debugPanel.setText(event.text);
      break;
    case "text_delta":
      output.append(event.delta);
      break;
  }
}
```

### Monitoring Tool Execution

Tool events form a complete lifecycle: `start -> delta(s) -> end -> result`.

```typescript
const stream = session.ask("What test files exist and what do they cover?");

for await (const event of stream) {
  switch (event.type) {
    case "tool_use_start":
      console.log(`[tool] ${event.name} starting (id: ${event.toolCallId})`);
      break;
    case "tool_use_end":
      // Arguments are fully parsed at this point
      console.log(`[tool] ${event.name} executing with:`, event.params);
      break;
    case "tool_result":
      if (event.isError) {
        console.error(`[tool] ${event.name} failed: ${event.output}`);
      } else {
        console.log(`[tool] ${event.name} completed in ${event.durationMs}ms`);
        // event.output contains the tool's text output
      }
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
  }
}
```

---

## Multi-Turn Conversations

Each `ask()` call is a turn. By default, each turn continues from the previous one, building up context.

```typescript
// Turn 1: establish context
const turn1 = await session.ask("What are the main API endpoints?").result();

// Turn 2: follow up (automatically includes turn 1's context)
const turn2 = await session.ask("Which ones lack input validation?").result();

// Turn 3: follow up further
const turn3 = await session.ask("Fix the validation gaps you found").result();
```

### Branching Conversations

Use `afterTurn` to branch from an earlier point in the conversation. The model only sees context up to and including the specified turn.

```typescript
const turn1 = await session.ask("What does this repo do?").result();
const turn2 = await session.ask("Show me the auth module").result();

// Branch from turn 1, ignoring turn 2 entirely.
// The model sees turn 1's context but not turn 2's.
const turn3 = await session.ask("Now explain the database layer", {
  afterTurn: turn1.id,
}).result();
```

This is useful for exploring different directions from the same starting point without polluting the context.

### Inspecting Session History

```typescript
const turns = session.getTurns();
console.log(`Session has ${turns.length} turns`);

for (const turn of turns) {
  console.log(`  [${turn.id}] "${turn.prompt}"`);
  console.log(`    Response: ${turn.text.slice(0, 80)}...`);
  console.log(`    Tools: ${turn.toolCalls.map(t => t.name).join(", ") || "none"}`);
  console.log(`    Tokens: ${turn.usage.totalTokens}`);
}

// Retrieve a specific turn
const specific = session.getTurn("t-abc123");
```

---

## Per-Turn Configuration Overrides

Override model, iteration limit, or thinking config for a single turn without mutating the session.

### Use a Cheaper Model for Simple Questions

```typescript
const summary = await session.ask("Give me a one-line summary of this repo", {
  model: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  maxIterations: 3,
  thinking: { effort: "low" },
}).result();
```

### Increase Iterations for Complex Tasks

```typescript
const analysis = await session.ask("Do a comprehensive security audit of the auth flow", {
  maxIterations: 30,
  thinking: { effort: "high" },
}).result();
```

---

## Cancellation

Use an `AbortSignal` to cancel a turn mid-stream.

```typescript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

try {
  const result = await session.ask("Analyze the entire codebase", {
    signal: controller.signal,
  }).result();
} catch (err) {
  if (err.name === "AbortError") {
    console.log("Turn was cancelled");
  }
}
```

---

## Error Handling

Errors are cleanly separated from response content. `TurnResult.text` is always the model's output; `TurnResult.error` is always the error (or null).

### Checking for Errors

```typescript
const result = await session.ask("Explain the auth module").result();

if (result.error) {
  console.error(`Turn failed: ${result.error.message}`);
  // result.text may be empty or partial
} else {
  console.log(result.text);
}
```

### Handling Errors in a Stream

```typescript
const stream = session.ask("Explain the auth module");

for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "error":
      // Unrecoverable error -- the turn will end after this
      console.error(`Error: ${event.message}`);
      break;
  }
}
```

### What the SDK Handles Automatically

You don't need to write retry logic for:

- Rate limiting (429s)
- Transient network failures
- Server errors (503s)

The SDK retries these internally with backoff. Only unrecoverable errors reach your code.

### Tool Failures Don't Fail the Turn

Tool execution errors are fed back to the model, which can retry or work around them. A failed tool call does **not** set `TurnResult.error`.

```typescript
const result = await session.ask("Read and summarize config.yaml").result();

// Even if the read tool fails (file not found), the model may still
// produce a useful response. Check toolCalls for details:
for (const tool of result.toolCalls) {
  if (tool.isError) {
    console.warn(`Tool ${tool.name} failed: ${tool.output}`);
  }
}
```

---

## Context Compaction

When enabled, the SDK automatically compacts the context when it approaches the model's context window limit. You can observe this via stream events.

```typescript
const stream = session.ask("Continue the analysis");

for await (const event of stream) {
  switch (event.type) {
    case "compaction":
      console.log(`Context compacted: ${event.tokensBefore} -> ${event.tokensAfter} tokens`);
      console.log(`Summary: ${event.summary.slice(0, 100)}...`);
      console.log(`Files still tracked: ${event.modifiedFiles.join(", ")}`);
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
  }
}
```

---

## Full Example

Putting it all together -- a complete session with streaming, branching, and per-turn overrides.

```typescript
import { AskForgeClient } from "askforge";

const client = new AskForgeClient({
  logger: console,
});

const session = await client.connect({
  repo: { url: "https://github.com/owner/repo", token: process.env.GITHUB_TOKEN },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinking: { type: "adaptive", effort: "high" },
  maxIterations: 15,
  compaction: { enabled: true, contextWindow: 200_000 },
});

// --- Turn 1: streaming ---
const stream = session.ask("What are the main API endpoints?");
for await (const event of stream) {
  switch (event.type) {
    case "turn_start":
      console.log(`Turn ${event.turnId} started`);
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_use_start":
      console.log(`  -> ${event.name}`);
      break;
    case "tool_result":
      console.log(`  <- ${event.name}: ${event.durationMs}ms ${event.isError ? "FAILED" : "ok"}`);
      break;
    case "compaction":
      console.log(`  Context compacted: ${event.tokensBefore} -> ${event.tokensAfter} tokens`);
      break;
    case "error":
      console.error(`  Error: ${event.message}`);
      break;
    case "turn_end":
      console.log(`  Done: ${event.metadata.iterations} iterations, ${event.metadata.latencyMs}ms`);
      break;
  }
}
const turn1 = await stream.result();

// --- Turn 2: simple (non-streaming) ---
const turn2 = await session.ask("How is auth handled?").result();
console.log(turn2.text);
console.log(`Tools used: ${turn2.toolCalls.map(t => t.name).join(", ")}`);

// --- Turn 3: branch from turn 1, skipping turn 2 ---
const turn3 = await session.ask("Now explain the database layer", {
  afterTurn: turn1.id,
}).result();

// --- Inspect session context ---
const turns = session.getTurns();
console.log(`\nSession has ${turns.length} turns`);
for (const t of turns) {
  console.log(`  [${t.id}] "${t.prompt}" -> ${t.toolCalls.length} tool calls`);
}

// --- Per-turn config override ---
const turn4 = await session.ask("Quick summary?", {
  model: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  maxIterations: 5,
  thinking: { effort: "low" },
}).result();

await session.close();
```

---

## Cleanup

Always close the session when done. This cleans up git worktrees and other resources.

```typescript
await session.close();
```

`close()` is idempotent -- calling it multiple times is safe. After closing, any call to `ask()` throws synchronously.
