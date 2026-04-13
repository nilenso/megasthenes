---
title: Sandboxed Execution
description: Run megasthenes in an isolated sandbox for secure code analysis.
sidebar:
  order: 3
---

megasthenes can execute all repository operations inside an isolated sandbox, providing multiple layers of security.

### Architecture

![Sandbox architecture diagram](../../../assets/sandbox-architecture.svg)

### Enabling Sandbox Mode

```ts
const client = new Client({
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

Generate a docker-compose file and start the sandbox:

```bash
# Generate docker-compose.sandbox.yml
bunx megasthenes setup-sandbox

# Start the sandbox
docker-compose -f docker-compose.sandbox.yml up -d
```

Prerequisites: Docker with [gVisor runtime](https://gvisor.dev/docs/user_guide/install/).

The `setup-sandbox` command accepts configuration flags:

```bash
bunx megasthenes setup-sandbox \
  --port 9090 \
  --generate-secret \
  --output ./docker-compose.sandbox.yml
```

| Flag | Default | Description |
|---|---|---|
| `--port` | 8080 | Host port to expose |
| `--secret` | (none) | Bearer token for API authentication |
| `--generate-secret` | — | Generate a random 32-char hex secret |
| `--output` | `./docker-compose.sandbox.yml` | Output file path |
| `--image-tag` | Library version | Container image tag |

### Resetting the Sandbox

To clean up all cloned repositories:

```ts
await client.resetSandbox();
```
