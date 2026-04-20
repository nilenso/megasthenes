/**
 * CLI for megasthenes — install system dependencies.
 *
 * @module
 */
import { installDeps } from "./install-deps.ts";

const command = process.argv[2];

switch (command) {
	case "install-deps":
		await installDeps(process.argv.slice(3));
		break;
	case undefined:
	case "--help":
	case "-h":
		console.log(`Usage: megasthenes <command>

Commands:
  install-deps   Check for and install missing prerequisites (git, ripgrep, fd)

Options:
  --help, -h     Show this help message`);
		break;
	default:
		console.error(`Unknown command: ${command}\nRun 'megasthenes --help' for usage.`);
		process.exit(1);
}
