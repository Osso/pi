import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launchDetachedPyrunRunner } from "../extensions/pyrun/src/detached-runner.ts";
import { launchDetachedBashRunner } from "../src/core/detached-bash-runner.ts";

const SERVICE_CGROUP = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pi-server.service\n";
const TERMINAL_CGROUP = "0::/user.slice/user-1000.slice/session-4.scope\n";
const SCOPE_MODULE = fileURLToPath(new URL("../src/core/detached-runner-scope.ts", import.meta.url));

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

afterEach(() => {
	process.env.PATH = originalPath;
	if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-runner-scope-"));
	tempDirs.push(dir);
	return dir;
}

/** A `systemd-run` stand-in that records its PID, argv, and bus env, then execs the wrapped command like --scope does. */
function installRecordingSystemdRun(dir: string): string {
	const log = join(dir, "systemd-run.log");
	const stub = join(dir, "systemd-run");
	writeFileSync(
		stub,
		[
			"#!/bin/sh",
			`printf 'pid=%s\\nruntime=%s\\nargs=%s\\n' "$$" "$XDG_RUNTIME_DIR" "$*" > '${log}'`,
			'while [ "$1" != "--" ]; do shift; done',
			"shift",
			'exec "$@"',
			"",
		].join("\n"),
	);
	chmodSync(stub, 0o755);
	process.env.PATH = `${dir}:${originalPath ?? ""}`;
	return log;
}

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			const text = readFileSync(path, "utf8");
			if (text.includes("args=")) return text;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("detached runners started from a systemd user service", () => {
	it("launch the Bash runner in its own scope with the user bus and the returned PID", async () => {
		const dir = makeTempDir();
		const log = installRecordingSystemdRun(dir);
		process.env.XDG_RUNTIME_DIR = "/run/user/4242";
		const manifestPath = join(dir, "launch.json");

		const pid = launchDetachedBashRunner(manifestPath, { cgroup: SERVICE_CGROUP });

		const record = await waitForFile(log);
		expect(record).toContain(`pid=${pid}\n`);
		expect(record).toContain("runtime=/run/user/4242\n");
		expect(record).toMatch(/args=--user --scope --quiet --collect -- \S+ .*launch\.json\n/);
	});

	it("launch the Pyrun runner in its own scope with the returned PID", async () => {
		const dir = makeTempDir();
		const log = installRecordingSystemdRun(dir);
		const manifestPath = join(dir, "launch.json");

		const pid = launchDetachedPyrunRunner(manifestPath, { cgroup: SERVICE_CGROUP });

		const record = await waitForFile(log);
		expect(record).toContain(`pid=${pid}\n`);
		expect(record).toMatch(/args=--user --scope --quiet --collect -- \S+ .*launch\.json\n/);
	});

	it("launch runners directly outside a service", async () => {
		const dir = makeTempDir();
		const log = installRecordingSystemdRun(dir);

		launchDetachedBashRunner(join(dir, "launch.json"), { cgroup: TERMINAL_CGROUP });
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(existsSync(log)).toBe(false);
	});
});

const userManagerAvailable =
	process.platform === "linux" && spawnSync("systemctl", ["--user", "show-environment"]).status === 0;

describe.skipIf(!userManagerAvailable)("detached runners survive their systemd service stopping", () => {
	it("keeps the scoped process alive and loses an unscoped sibling", async () => {
		const dir = makeTempDir();
		const probe = join(dir, "probe.ts");
		const pids = join(dir, "pids.json");
		writeFileSync(
			probe,
			[
				'import { spawn } from "node:child_process";',
				'import { writeFileSync } from "node:fs";',
				`import { readOwnCgroup, runnerInvocationOutsideService } from ${JSON.stringify(SCOPE_MODULE)};`,
				'const sleeper = { executable: "sleep", args: ["120"] };',
				"const scoped = runnerInvocationOutsideService(sleeper, readOwnCgroup());",
				'const start = (i) => spawn(i.executable, i.args, { detached: true, stdio: "ignore" });',
				"const kept = start(scoped);",
				"const lost = start(sleeper);",
				`setTimeout(() => writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ kept: kept.pid, lost: lost.pid })), 300);`,
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
		);
		const unit = `pi-runner-scope-test-${process.pid}-${Date.now()}`;
		execFileSync("systemd-run", [
			"--user",
			`--unit=${unit}`,
			"--quiet",
			"--collect",
			"-p",
			"KillMode=control-group",
			process.execPath,
			"--experimental-strip-types",
			probe,
		]);
		let recorded: { kept: number; lost: number } | undefined;
		try {
			for (let attempt = 0; attempt < 100 && !recorded; attempt++) {
				if (existsSync(pids)) recorded = JSON.parse(readFileSync(pids, "utf8"));
				else await new Promise((resolve) => setTimeout(resolve, 50));
			}
			if (!recorded) throw new Error("Probe service did not record its child PIDs");
			expect(isAlive(recorded.kept)).toBe(true);
			expect(isAlive(recorded.lost)).toBe(true);

			execFileSync("systemctl", ["--user", "stop", unit]);
			await new Promise((resolve) => setTimeout(resolve, 300));

			expect(isAlive(recorded.lost)).toBe(false);
			expect(isAlive(recorded.kept)).toBe(true);
		} finally {
			spawnSync("systemctl", ["--user", "stop", unit]);
			for (const pid of [recorded?.kept, recorded?.lost]) if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 30_000);
});
