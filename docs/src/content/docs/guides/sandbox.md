---
title: Sandboxed Execution
description: Run megasthenes in an isolated sandbox for secure code analysis.
sidebar:
  order: 6
---

megasthenes can execute all repository operations inside an isolated sandbox, providing multiple layers of security.

### Architecture

![Sandbox architecture diagram](../../../assets/sandbox-architecture.svg)

### Enabling Sandbox Mode

Pass sandbox configuration to the `Client` constructor:

```ts
import { Client } from "@nilenso/megasthenes";

const client = new Client({
  sandbox: {
    baseUrl: "http://localhost:8080",
    timeoutMs: 120_000,
    secret: "optional-auth-secret",
  },
});
```

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | `string` | HTTP endpoint of the sandbox worker. Required. |
| `timeoutMs` | `number` | Request timeout in ms. Required. |
| `secret` | `string` | Bearer token for [API authentication](#authentication). Optional. |

When sandbox mode is enabled:

- Repository cloning happens inside the sandbox container
- All tool execution (file reads, searches, git operations) runs in isolation
- The host filesystem is never accessed directly

You can monitor clone progress via the optional `onProgress` callback on `connect()`:

```ts
const session = await client.connect(sessionConfig, (message) => {
  console.log(`Clone progress: ${message}`);
});
```

### Security Layers

| Layer | Mechanism | Purpose |
|---|---|---|
| Container | Podman/Docker | Process and filesystem isolation |
| Filesystem | bubblewrap (bwrap) | Read-only bind mounts, no network |
| Syscall | seccomp | Restricts allowed system calls |
| Process | Namespace isolation | Separate PID/network/mount namespaces |

### Prerequisites

The sandbox runs on **Linux** and requires Docker and gVisor.

#### Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

#### Install gVisor

```bash
# Download runsc and the containerd shim
ARCH=$(uname -m)
sudo curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}/runsc" -o /usr/local/bin/runsc
sudo curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}/containerd-shim-runsc-v1" -o /usr/local/bin/containerd-shim-runsc-v1
sudo chmod +x /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1

# Register runsc as a Docker runtime and restart
sudo runsc install
sudo systemctl restart docker
```

Verify both are working:

```bash
docker info --format '{{json .Runtimes}}' | grep runsc
```

### Running the Sandbox Server

Download the [compose file](https://raw.githubusercontent.com/nilenso/megasthenes/main/docker-compose.sandbox.yml) and start the sandbox:

```bash
curl -O https://raw.githubusercontent.com/nilenso/megasthenes/main/docker-compose.sandbox.yml
docker compose -f docker-compose.sandbox.yml up -d
```

Verify the sandbox is running:

```bash
curl http://localhost:8080/health
```

You should see `{"ok":true}` in the response.

### Authentication

The sandbox API supports optional bearer token authentication. Without it, anyone who can reach the sandbox port can clone repos, execute tools, and delete data.

To enable it, set the `SANDBOX_SECRET` environment variable in the compose file:

```yaml
environment:
  - PORT=8080
  - SANDBOX_SECRET=your-secret-here
```

Every request to the sandbox must then include an `Authorization: Bearer <secret>` header. The client handles this automatically when you pass `secret` in the [sandbox config](#enabling-sandbox-mode).

Authentication is optional when the sandbox only listens on localhost. It is recommended when the sandbox is reachable over a network.

### Resetting the Sandbox

To clean up all cloned repositories:

```ts
await client.resetSandbox();
```
