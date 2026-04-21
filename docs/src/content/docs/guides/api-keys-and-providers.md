---
title: API Keys and Providers
description: How to pick a provider and model, and override them per session or per ask. Credential resolution is handled by pi-ai.
sidebar:
  order: 2
---

Megasthenes delegates provider and credential resolution to [pi-ai]. Any provider pi-ai supports works with megasthenes, and the matching env var is picked up automatically — you never pass a key into the `Client`.

For the full list of providers, env-var mappings, fallback chains (Anthropic OAuth, Bedrock credential chain, Vertex ADC), and OAuth flows, see the pi-ai docs:

- [Supported providers and model IDs][models]
- [Environment Variables][pi-env]
- [OAuth Providers][pi-oauth]

### Per-session selection

`provider` and `model` are required per session at `connect()` time — there is no library-level default. Both are passed through to pi-ai's `getModel(provider, id)`.

```ts
import { Client } from "@nilenso/megasthenes";

const client = new Client();
const session = await client.connect({
  repo: { url: "https://github.com/owner/repo" },
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  maxIterations: 20,
});
```

If the matching env var for your chosen provider isn't set, `connect()` or the first `ask()` throws. See [Error Handling](/megasthenes/guides/error-handling/) to classify by `errorType`.

### Per-ask override

Swap the model for a single turn without rebuilding the client. Other turns in the same session keep the session default:

```ts
await session.ask("Summarize the architecture.", {
  model: { provider: "openai", id: "o3" },
  thinking: { effort: "low" },
}).result();
```

`maxIterations` and `thinking` can be overridden on a single `ask()` the same way — see [`AskOptions`][askopts].

[pi-ai]: https://github.com/badlogic/pi-mono/tree/main/packages/ai
[models]: https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/models.generated.ts
[pi-env]: https://github.com/badlogic/pi-mono/tree/main/packages/ai#environment-variables-nodejs-only
[pi-oauth]: https://github.com/badlogic/pi-mono/tree/main/packages/ai#oauth-providers
[askopts]: /megasthenes/api/interfaces/askoptions/
