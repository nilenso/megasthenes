import { spawnSync } from "node:child_process";
import { platform } from "node:os";

interface Dependency {
	name: string;
	command: string;
	versionFlag: string;
}

const dependencies: Dependency[] = [
	{ name: "git", command: "git", versionFlag: "--version" },
	{ name: "ripgrep", command: "rg", versionFlag: "--version" },
	{ name: "fd", command: "fd", versionFlag: "--version" },
];

type PackageManager = "brew" | "apt" | "dnf" | "pacman" | "apk";

const installCommands: Record<PackageManager, Record<string, string>> = {
	brew: { git: "git", ripgrep: "ripgrep", fd: "fd" },
	apt: { git: "git", ripgrep: "ripgrep", fd: "fd-find" },
	dnf: { git: "git", ripgrep: "ripgrep", fd: "fd-find" },
	pacman: { git: "git", ripgrep: "ripgrep", fd: "fd" },
	apk: { git: "git", ripgrep: "ripgrep", fd: "fd" },
};

function isInstalled(command: string, versionFlag: string): boolean {
	const result = spawnSync(command, [versionFlag], { stdio: "pipe" });
	return result.status === 0;
}

function detectPackageManager(): PackageManager | null {
	const managers: PackageManager[] = ["brew", "apt", "dnf", "pacman", "apk"];
	for (const pm of managers) {
		if (spawnSync("which", [pm], { stdio: "pipe" }).status === 0) {
			return pm;
		}
	}
	return null;
}

function buildInstallArgs(pm: PackageManager, pkg: string): string[] {
	switch (pm) {
		case "brew":
			return ["install", pkg];
		case "pacman":
			return ["-S", "--noconfirm", pkg];
		default:
			return ["install", "-y", pkg];
	}
}

function installPackage(pm: PackageManager, pkg: string): boolean {
	const args = buildInstallArgs(pm, pkg);
	const needsSudo = pm !== "brew";
	const command = needsSudo ? "sudo" : pm;
	const fullArgs = needsSudo ? [pm, ...args] : args;

	console.log(`  Running: ${command} ${fullArgs.join(" ")}`);
	const result = spawnSync(command, fullArgs, { stdio: "inherit" });
	return result.status === 0;
}

export async function installDeps(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`Usage: megasthenes install-deps

Check for and install missing prerequisites (git, ripgrep, fd).
Detects your package manager automatically.`);
		return;
	}

	const missing: Dependency[] = [];

	console.log("Checking prerequisites:\n");
	for (const dep of dependencies) {
		const installed = isInstalled(dep.command, dep.versionFlag);
		const status = installed ? "installed" : "missing";
		console.log(`  ${dep.name} (${dep.command}): ${status}`);
		if (!installed) missing.push(dep);
	}

	if (missing.length === 0) {
		console.log("\nAll prerequisites are installed.");
		return;
	}

	console.log(`\n${missing.length} missing: ${missing.map((d) => d.name).join(", ")}`);

	const os = platform();
	if (os !== "darwin" && os !== "linux") {
		console.error(`\nAutomatic installation is not supported on ${os}.`);
		console.error("Please install the missing tools manually.");
		process.exit(1);
	}

	const pm = detectPackageManager();
	if (!pm) {
		console.error("\nNo supported package manager found (brew, apt, dnf, pacman, apk).");
		console.error("Please install the missing tools manually.");
		process.exit(1);
	}

	if (pm !== "brew") {
		console.log(`\nNote: ${pm} requires sudo. You may be prompted for your password.`);
	}

	console.log(`\nInstalling with ${pm}:\n`);

	const failed: string[] = [];
	for (const dep of missing) {
		const pkg = installCommands[pm][dep.name];
		if (!installPackage(pm, pkg)) {
			failed.push(dep.name);
		}
	}

	if (failed.length > 0) {
		console.error(`\nFailed to install: ${failed.join(", ")}`);
		process.exit(1);
	}

	console.log("\nAll prerequisites installed.");
}
