import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { isProcessIdentityAlive, readProcessIdentity } from "../src/core/runtime-process.ts";

describe("runtime process identity", () => {
	test("treats an exited zombie process as dead before its parent reaps it", () => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		if (!child.pid) throw new Error("Expected child PID");
		const identity = readProcessIdentity(child.pid);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);

		expect(isProcessIdentityAlive(identity)).toBe(false);
	});

	test("matches a live process only at its exact start time", () => {
		const identity = readProcessIdentity(process.pid);

		expect(identity).toEqual({ pid: process.pid, startTimeTicks: expect.any(Number) });
		expect(identity.startTimeTicks).toBeGreaterThan(0);
		expect(isProcessIdentityAlive(identity)).toBe(true);
		expect(isProcessIdentityAlive({ ...identity, startTimeTicks: identity.startTimeTicks + 1 })).toBe(false);
	});
});
