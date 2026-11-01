import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../../extensions/periodic-checks/src/index.ts";

const home = mkdtempSync(join(tmpdir(), "periodic-timeout-"));
const originalPath = process.env.PATH;
const project = join(home, "project");
const bin = join(home, "bin");
const marker = join(home, "timeout");
mkdirSync(project);
mkdirSync(bin);
execFileSync("git", ["init", "--quiet"], { cwd: project });
writeFileSync(join(project, "periodic-checks.md"), "---\ntype: checks\ninterval_seconds: 1\n---\n");
const git = join(bin, "git");
writeFileSync(
	git,
	`#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
if (fs.existsSync(${JSON.stringify(marker)})) {
  fs.unlinkSync(${JSON.stringify(marker)});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
}
const result = cp.spawnSync('git', process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, PATH: ${JSON.stringify(originalPath)} },
});
process.exit(result.status ?? 1);
`,
);
chmodSync(git, 0o755);

const handlers = new Map();
let calls = 0;
let resolveError;
let resolveSpawn;
const errorNotice = new Promise((resolve) => {
	resolveError = resolve;
});
const spawned = new Promise((resolve) => {
	resolveSpawn = resolve;
});
const ctx = {
	cwd: project,
	mode: "tui",
	ui: { notify: (text, type) => resolveError({ text, type, calls }) },
	multiAgentStore: { listAgents: () => [] },
	sessionManager: { getSessionId: () => "main-session" },
};
const pi = {
	on: (name, handler) => handlers.set(name, handler),
	registerCommand: () => {},
	getActiveTools: () => ["spawn_agent", "send_agent_message"],
	callTool: () => {
		calls++;
		resolveSpawn();
		return Promise.resolve({ content: [], details: { dispatched: true } });
	},
};
try {
	extension(pi);
	handlers.get("session_start")({}, ctx);
	process.env.PATH = `${bin}:${originalPath}`;
	writeFileSync(marker, "timeout");
	const watchdog = setTimeout(() => {
		throw new Error("Timed out waiting for periodic audit");
	}, 15000);
	const notice = await errorNotice;
	assert.equal(notice.type, "error");
	assert.match(notice.text, /Periodic audit refused.*Cannot discover Git project root.*ETIMEDOUT/);
	assert.equal(notice.calls, 0, "failed Git check must not spawn an audit");
	await spawned;
	assert.equal(calls, 1, "a later healthy tick must spawn an audit");
	clearTimeout(watchdog);
	handlers.get("session_shutdown")();
} finally {
	process.env.PATH = originalPath;
	rmSync(home, { recursive: true, force: true });
}
