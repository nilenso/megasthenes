/**
 * Sandbox module — isolated git and tool execution.
 *
 * This module is for internal use. External users should interact with
 * the sandbox via its HTTP API (see README.md) or use the main megasthenes
 * `connect()` API which handles sandboxing transparently.
 *
 * Components:
 *   - client.ts: Internal HTTP client for the sandbox worker
 *   - worker.ts: HTTP server (runs in container)
 *   - isolation/: Security primitives (bwrap, seccomp)
 */

export { type CloneResult, SandboxClient, type SandboxClientConfig } from "./client";
export * as isolation from "./isolation";
