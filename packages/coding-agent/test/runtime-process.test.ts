import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { describe, expect, test } from "vitest";
import { isProcessIdentityAlive, readProcessIdentity } from "../src/core/runtime-process.ts";

describe("runtime process identity", () => {
	test.runIf(process.platform === "linux")(
		"treats an exited zombie process as dead before its parent reaps it",
		async () => {
			const helper = spawn(
				"python3",
				[
					"-c",
					[
						"import os, sys",
						"pid = os.fork()",
						"if pid == 0:",
						"    os._exit(0)",
						"print(f'READY {pid}', flush=True)",
						"os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)",
						"print('ZOMBIE', flush=True)",
						"if sys.stdin.readline().strip() == 'REAP':",
						"    os.waitpid(pid, 0)",
					].join("\n"),
				],
				{ stdio: ["pipe", "pipe", "inherit"] },
			);
			if (!helper.stdout || !helper.stdin) throw new Error("Expected helper pipes");
			const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
			try {
				const ready = await lines.next();
				const childPid = Number.parseInt(ready.value?.match(/^READY (\d+)$/)?.[1] ?? "", 10);
				if (!Number.isFinite(childPid)) throw new Error(`Invalid helper output: ${ready.value}`);
				const identity = readProcessIdentity(childPid);
				const zombie = await lines.next();
				expect(zombie.value).toBe("ZOMBIE");
				expect(isProcessIdentityAlive(identity)).toBe(false);
			} finally {
				helper.stdin.end("REAP\n");
				if (helper.exitCode === null) await once(helper, "exit");
			}
		},
	);

	test.runIf(process.platform === "linux" || process.platform === "darwin")(
		"preserves process identity across a real exec and rejects it after exit",
		async () => {
			const child = spawn(
				"/bin/sh",
				[
					"-c",
					'IFS= read -r _ || exit 125; exec "$@"',
					"identity-exec-gate",
					process.execPath,
					"-e",
					"process.stdout.write('READY ' + process.pid + '\\n'); setInterval(() => {}, 1000);",
				],
				{ stdio: ["pipe", "pipe", "inherit"] },
			);
			if (!child.pid || !child.stdin || !child.stdout) throw new Error("Expected an exec-gated child");
			const identity = readProcessIdentity(child.pid);
			const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
			try {
				child.stdin.end("EXEC\n");
				const ready = await lines.next();
				expect(ready.value).toBe(`READY ${identity.pid}`);
				expect(readProcessIdentity(identity.pid)).toEqual(identity);
				expect(isProcessIdentityAlive(identity)).toBe(true);
			} finally {
				child.kill("SIGTERM");
				if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
			}
			expect(isProcessIdentityAlive(identity)).toBe(false);
		},
	);

	test("matches a live process only at its exact start time", () => {
		const identity = readProcessIdentity(process.pid);

		expect(identity).toEqual({ pid: process.pid, startTimeTicks: expect.any(Number) });
		expect(identity.startTimeTicks).toBeGreaterThan(0);
		expect(isProcessIdentityAlive(identity)).toBe(true);
		expect(isProcessIdentityAlive({ ...identity, startTimeTicks: identity.startTimeTicks + 1 })).toBe(false);
	});
});
