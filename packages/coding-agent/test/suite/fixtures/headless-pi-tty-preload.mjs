Object.defineProperties(process.stdin, {
	isTTY: { configurable: true, value: true },
	isRaw: { configurable: true, value: false, writable: true },
});
Object.defineProperties(process.stdout, {
	isTTY: { configurable: true, value: true },
	columns: { configurable: true, value: 100 },
	rows: { configurable: true, value: 30 },
});
process.stdin.setRawMode = (enabled) => {
	process.stdin.isRaw = enabled;
	return process.stdin;
};
