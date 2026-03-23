---
title: Sandboxed Execution
description: Run ask-forge in an isolated sandbox for secure code analysis.
sidebar:
  order: 3
---

ask-forge can execute all repository operations inside an isolated sandbox, providing multiple layers of security.

### Architecture

![Sandbox architecture diagram](../../../assets/sandbox-architecture.svg)

### Enabling Sandbox Mode

```ts
const client = new AskForgeClient({
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4-20250514",
  sandbox: {
    baseUrl: "http://localhost:8080",
  },
});
```

When sandbox mode is enabled:

- Repository cloning happens inside the sandbox container
- All tool execution (file reads, searches, git operations) runs in isolation
- The host filesystem is never accessed directly

### Security Layers

| Layer | Mechanism | Purpose |
|---|---|---|
| Container | Podman/Docker | Process and filesystem isolation |
| Filesystem | bubblewrap (bwrap) | Read-only bind mounts, no network |
| Syscall | seccomp | Restricts allowed system calls |
| Process | Namespace isolation | Separate PID/network/mount namespaces |

### Running the Sandbox Server

The sandbox runs as an HTTP server. Start it with:

```bash
bun run web/server.ts
```

Or via container:

```bash
podman run -p 8080:8080 ask-forge-sandbox
```

### Resetting the Sandbox

To clean up all cloned repositories:

```ts
await client.resetSandbox();
```
