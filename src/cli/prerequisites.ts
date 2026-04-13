import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export function checkDocker(): boolean {
	const result = spawnSync("docker", ["--version"], { stdio: "pipe" });
	if (result.status !== 0) {
		console.warn("Warning: docker not found on PATH. The sandbox requires Docker with gVisor runtime (runsc).");
		return false;
	}
	return true;
}

export function checkDockerCompose(): boolean {
	const result = spawnSync("docker-compose", ["version"], { stdio: "pipe" });
	if (result.status !== 0) {
		console.warn(
			"Warning: docker-compose not found. Install it to start the sandbox (e.g. brew install docker-compose).",
		);
		return false;
	}
	return true;
}

export function checkGvisor(): boolean {
	const result = spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], {
		stdio: "pipe",
	});
	const output = result.stdout?.toString() ?? "";
	if (!output.includes("runsc")) {
		console.warn(`Warning: gVisor runtime (runsc) not detected in Docker.
The sandbox requires gVisor for full isolation.
Install: https://gvisor.dev/docs/user_guide/install/
After installing, add to /etc/docker/daemon.json:
  { "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } } }
Then: sudo systemctl restart docker
`);
		return false;
	}
	return true;
}

export function checkPlatform(): boolean {
	if (platform() !== "linux") {
		console.warn(
			"Note: gVisor only runs on Linux. You will need Docker running in a Linux VM with gVisor installed as a runtime. See: https://gvisor.dev/docs/user_guide/install/",
		);
		return false;
	}
	return true;
}

export function checkSandboxPrerequisites(): void {
	if (!checkPlatform()) return;

	const hasDocker = checkDocker();
	if (!hasDocker) return;

	checkDockerCompose();
	checkGvisor();
}
