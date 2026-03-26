# Install dependencies
install:
    bun install

# Run all tests
test:
    bun test

# Run isolation layer tests (bwrap + seccomp)
isolation-tests:
    bun test test/sandbox/isolation/isolation.test.ts

# Run sandbox integration tests (requires running sandbox)
sandbox-tests: sandbox-up
    @echo "Waiting for sandbox..."
    @sleep 2
    bun test test/sandbox/sandbox.integration.test.ts || true
    podman-compose --in-pod=false down

# Run all sandbox tests (isolation + integration)
sandbox-all-tests: isolation-tests sandbox-tests

# Build sandbox container
sandbox-build:
    podman-compose --in-pod=false build

# Start sandbox container
sandbox-up: sandbox-build
    podman-compose --in-pod=false up -d

# Stop sandbox container
sandbox-down:
    podman-compose --in-pod=false down

# View sandbox logs
sandbox-logs:
    podman-compose --in-pod=false logs -f

