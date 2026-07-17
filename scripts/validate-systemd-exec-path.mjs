#!/usr/bin/env node

const [path] = process.argv.slice(2);

if (!path || /[\s%$&'"\\]/u.test(path)) {
	console.error(`Path cannot be inserted safely into systemd ExecStart: ${path ?? "(missing)"}`);
	process.exit(1);
}
