---
title: Local Setup
description: Clone megasthenes, install dependencies, and run the project locally.
sidebar:
  order: 1
---

Use this flow if you want to work on megasthenes itself rather than consume it as a library.

### Clone and install

```bash
git clone https://github.com/nilenso/megasthenes.git
cd megasthenes
bun install
```

### Ask a question

```bash
bun run scripts/ask.ts https://github.com/owner/repo "What frameworks does this project use?"
```

The local CLI reads its model and prompt settings from `src/config.ts`.

### Set up the sandbox container

If you are working on sandboxed execution or running sandbox integration tests, build and start the sandbox container defined in `docker-compose.yml`:

```bash
just sandbox-build
just sandbox-up
```

These targets use `podman-compose` to build the image from `src/sandbox/Containerfile` and start the sandbox server on port `8080`.

### Run tests

```bash
just test
just isolation-tests
just sandbox-tests
just sandbox-all-tests
```

Use `just test` for the main unit test suite. The sandbox targets cover the container and isolation layers.

### Documentation

Build the docs site from the repo root:

```bash
just docs-build
```

Preview the built site locally:

```bash
cd docs
bun run preview
```

For live docs authoring instead of a production preview, run `just docs-dev`.
