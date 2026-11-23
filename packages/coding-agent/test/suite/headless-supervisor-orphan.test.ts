import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionHealth } from "../../src/core/session-control-db/session-health.ts";
import { HEADLESS_SUPERVISOR_SESSION_ID } from "./fixtures/headless-supervisor.ts";

const FIXTURE_URL = pathToFileURL(join(import.meta.dirname, "fixtures", "headless-supervisor.ts")).href;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("headless Supervisor stand-in", () => {
	// A test process killed by a timeout never reaches close(); the stand-in must not outlive it.
	it("exits when the test process that registered it is killed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-headless-supervisor-"));
		const controlDbPath = join(dir, "control.sqlite");
		const parent = spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const { registerHeadlessSupervisor } = await import(${JSON.stringify(FIXTURE_URL)});
await registerHeadlessSupervisor(${JSON.stringify(controlDbPath)});
console.log("registered");
setInterval(() => {}, 2 ** 30);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		let standInPid: number | undefined;
		cleanups.push(() => {
			parent.kill("SIGKILL");
			if (standInPid !== undefined && isAlive(standInPid)) process.kill(standInPid, "SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		});
		await new Promise<void>((resolve, reject) => {
			parent.stdout.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("registered")) resolve();
			});
			parent.once("exit", (code) => reject(new Error(`parent exited early with ${code}`)));
		});
		standInPid = readSessionHealth(controlDbPath, HEADLESS_SUPERVISOR_SESSION_ID)?.pid ?? undefined;
		if (standInPid === undefined) throw new Error("stand-in pid was not recorded");
		const pid = standInPid;
		expect(isAlive(pid)).toBe(true);

		parent.kill("SIGKILL");

		await waitFor(() => !isAlive(pid), "the orphaned stand-in to exit");
	});
});
