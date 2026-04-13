export function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined) {
		console.error(`Error: ${flag} requires a value.`);
		process.exit(1);
	}
	return value;
}
