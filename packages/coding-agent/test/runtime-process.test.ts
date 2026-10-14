import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { describe, expect, test } from "vitest";
import { isProcessIdentityAlive, readProcessGroupId, readProcessIdentity } from "../src/core/runtime-process.ts";

const supportsExactIdentity = process.platform === "linux" || process.platform === "darwin";

describe("runtime process identity", () => {
	test.runIf(supportsExactIdentity)("treats an exited zombie process as dead before its parent reaps it", async () => {
		const helper = spawn(
			"python3",
			[
				"-c",
				[
					"import os, signal, sys",
					// SIGCHLD is delivered after exit; no wait call reaps the child until REAP.
					"signal.signal(signal.SIGCHLD, lambda *_: print('ZOMBIE', flush=True))",
					"read_fd, write_fd = os.pipe()",
					"pid = os.fork()",
					"if pid == 0:",
					"    os.close(write_fd)",
					"    os.read(read_fd, 1)",
					"    os._exit(0)",
					"os.close(read_fd)",
					"print(f'READY {pid}', flush=True)",
					"sys.stdin.readline()",
					"os.close(write_fd)",
					"sys.stdin.readline()",
					"os.waitpid(pid, 0)",
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
			expect(isProcessIdentityAlive(identity)).toBe(true);
			helper.stdin.write("EXIT\n");
			const zombie = await lines.next();
			expect(zombie.value).toBe("ZOMBIE");
			// The unreaped PID must still exist with the same creation marker.
			expect(readProcessIdentity(childPid)).toEqual(identity);
			expect(isProcessIdentityAlive(identity)).toBe(false);
		} finally {
			helper.stdin.end("EXIT\nREAP\n");
			if (helper.exitCode === null && helper.signalCode === null) await once(helper, "exit");
			await lines.return?.();
		}
	});

	test.runIf(supportsExactIdentity)(
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
				{ detached: true, stdio: ["pipe", "pipe", "inherit"] },
			);
			if (!child.pid || !child.stdin || !child.stdout) throw new Error("Expected an exec-gated child");
			const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
			let identity: ReturnType<typeof readProcessIdentity>;
			try {
				identity = readProcessIdentity(child.pid);
				expect(readProcessGroupId(child.pid)).toBe(child.pid);
				child.stdin.end("EXEC\n");
				const ready = await lines.next();
				expect(ready.value).toBe(`READY ${identity.pid}`);
				expect(readProcessIdentity(identity.pid)).toEqual(identity);
				expect(readProcessGroupId(identity.pid)).toBe(identity.pid);
				expect(isProcessIdentityAlive(identity)).toBe(true);
			} finally {
				child.kill("SIGTERM");
				if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
				child.stdin.destroy();
				await lines.return?.();
			}
			expect(isProcessIdentityAlive(identity)).toBe(false);
		},
	);

	test.runIf(supportsExactIdentity)("matches a live process only at its exact start time", () => {
		const identity = readProcessIdentity(process.pid);

		expect(identity).toEqual({ pid: process.pid, startTimeTicks: expect.any(Number) });
		expect(identity.startTimeTicks).toBeGreaterThan(0);
		expect(isProcessIdentityAlive(identity)).toBe(true);
		expect(isProcessIdentityAlive({ ...identity, startTimeTicks: identity.startTimeTicks + 1 })).toBe(false);
	});
});
