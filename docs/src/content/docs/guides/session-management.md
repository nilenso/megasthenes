---
title: Session Management
description: Session lifecycle, state accessors, restoration, and conversation branching.
sidebar:
  order: 4
---

A `Session` manages a multi-turn conversation with an AI model about a code repository. It holds the conversation context, tracks completed turns, and cleans up resources on close.

### Lifecycle

```ts
import { Client } from "@nilenso/megasthenes";

const client = new Client();

// 1. Connect — clones the repo and creates a session
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});

// 2. Ask — each call continues the conversation with full context
await session.ask("What does this repo do?").result();
await session.ask("How are the tests structured?").result();

// 3. Close — cleans up the git worktree
await session.close();
```

### Session Properties

| Property | Type | Description |
|---|---|---|
| `id` | `string` | Unique session identifier (UUID). |
| `repo` | `Repo` | The connected repository (URL, local path, commit SHA). |
| `config` | `PublicSessionConfig` | Immutable snapshot of the session configuration. |

### Accessors

```ts
// Get all completed turns in chronological order
const turns = session.getTurns();

// Get a specific turn by ID
const turn = session.getTurn("some-turn-id");

// Get the current compaction summary (if compaction has occurred)
const summary = session.getCompactionSummary();
```

### Session Restoration

You can save and restore a session's state to continue a conversation across process restarts or different sessions.

#### What to persist

- **`session.getTurns()`** — the ordered history of completed turns (`TurnResult[]`).
- **`session.getCompactionSummary()`** — the current compaction summary (`string | undefined`), if any turn triggered compaction.

Both are JSON-serializable: `TurnResult` and `Step` contain only strings, numbers, booleans, plain objects, and arrays — no `Date` instances, class instances, or `Buffer`s. `JSON.stringify` / `JSON.parse` round-trips cleanly. The one field to watch is `TurnResult.error.details` (typed as `unknown`) — strip or sanitize it if the producer may emit non-serializable values like circular references.

#### Saving

```ts
import { writeFile } from "node:fs/promises";

const payload = {
  version: 1,
  repoUrl: session.repo.url,
  commitish: session.repo.commitish,   // resolved commit SHA, not the requested ref
  model: session.config.model,
  turns: session.getTurns(),
  lastCompactionSummary: session.getCompactionSummary(),
};

await writeFile("session.json", JSON.stringify(payload));
await session.close();
```

#### Restoring

```ts
import { readFile } from "node:fs/promises";

const raw = JSON.parse(await readFile("session.json", "utf8"));
if (raw.version !== 1) {
  throw new Error(`Unsupported session payload version: ${raw.version}`);
}

const session = await client.connect({
  repo: { url: raw.repoUrl, commitish: raw.commitish },
  model: raw.model,
  maxIterations: 20,
  initialTurns: raw.turns,
  lastCompactionSummary: raw.lastCompactionSummary,
});

await session.ask("Based on our earlier discussion, what else should I know?").result();
```

`initialTurns` seeds the session with prior turn results; `lastCompactionSummary` provides the compaction state so context compression continues seamlessly. If compaction ran in the original session, pass `lastCompactionSummary` too — dropping it discards pre-compaction context that the saved turns implicitly reference.

#### Schema versioning

`TurnResult` and `Step` are part of the public API but can evolve across megasthenes releases. Tag every persisted payload with an explicit `version` (as shown above) and fail loudly when the loader sees an unfamiliar version — don't feed an unknown shape into `initialTurns`. When you bump your own `version`, write a small migration that upgrades old payloads to the new shape rather than discarding them.

#### What to match on restore

- **`repo.url` and `repo.commitish`** should match the original session. Saved turns reference file paths and line numbers at a specific commit; restoring against a different commit can make the model reason from stale coordinates.
- **`model`** can differ — you're free to restore with a different provider/model — but the restored model picks up the conversation blind. Switching to a model with a smaller context window or weaker tool-use may degrade answers.

### Conversation Branching

Use the `afterTurn` option to branch the conversation from a specific turn, creating a "what if" fork:

```ts
const turn1 = await session.ask("What testing frameworks does this project use?").result();
const turn2 = await session.ask("How is the CI pipeline configured?").result();

// Branch back to after turn 1, ignoring turn 2
const stream = session.ask("What about integration tests specifically?", {
  afterTurn: turn1.id,
});
```

This restores the conversation context to the state it was in right after the specified turn, then appends the new question. The original conversation history is preserved — branching creates a new path, it doesn't rewrite history.

### Cleanup

`session.close()` removes the git worktree created for this session. It is safe to call multiple times and returns a `Promise<void>`.

```ts
await session.close();
```
