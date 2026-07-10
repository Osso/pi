import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeBwrap {
	command: string;
	logPath: string;
}

export function writeFakeBwrap(tempDir: string): FakeBwrap {
	const command = join(tempDir, "fake-bwrap.mjs");
	const logPath = join(tempDir, "fake-bwrap-args.json");
	writeFileSync(
		command,
		`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("fake-bwrap 1.0");
  process.exit(0);
}
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args));
const separator = args.indexOf("--");
if (separator === -1 || separator + 1 >= args.length) process.exit(2);
const env = {};
for (let index = 0; index < separator; index++) {
  if (args[index] === "--setenv") {
    env[args[index + 1]] = args[index + 2];
    index += 2;
  }
}
const child = spawn(args[separator + 1], args.slice(separator + 2), {
  env,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`,
	);
	chmodSync(command, 0o755);
	return { command, logPath };
}
