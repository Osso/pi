import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({
	processes: new Map<number, { pid: number; startTimeTicks: number; state: string; processGroupId: number }>(),
	failure: undefined as Error | undefined,
}));

vi.mock("node:module", () => ({
	createRequire: () => () => ({
		readProcessInfo(pid: number) {
			if (native.failure) throw native.failure;
			const info = native.processes.get(pid);
			if (!info) throw Object.assign(new Error(`Process ${pid} does not exist`), { code: "ESRCH" });
			return { ...info };
		},
	}),
}));

import * as runtimeProcess from "../src/core/runtime-process.ts";
import { isProcessIdentityAlive, readProcessIdentity } from "../src/core/runtime-process.ts";

beforeEach(() => {
	vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
	native.failure = undefined;
	native.processes.set(4200, { pid: 4200, startTimeTicks: 1_792_000_000_123_456, state: "R", processGroupId: 4200 });
});

afterEach(() => {
	vi.unstubAllGlobals();
	native.processes.clear();
});

describe("Darwin kernel process identity", () => {
	test("reads the native creation marker and matches only that process instance", () => {
		const identity = readProcessIdentity(4200);
		expect(identity).toEqual({ pid: 4200, startTimeTicks: 1_792_000_000_123_456 });
		expect(isProcessIdentityAlive(identity)).toBe(true);
		expect(isProcessIdentityAlive({ ...identity, startTimeTicks: identity.startTimeTicks + 1 })).toBe(false);
	});

	test("rejects a reused PID with a different native creation marker", () => {
		const original = readProcessIdentity(4200);
		native.processes.set(4200, {
			pid: 4200,
			startTimeTicks: original.startTimeTicks + 100,
			state: "R",
			processGroupId: 4200,
		});
		expect(isProcessIdentityAlive(original)).toBe(false);
		expect(isProcessIdentityAlive(readProcessIdentity(4200))).toBe(true);
	});

	test("treats a zombie or a missing native process as dead", () => {
		const identity = readProcessIdentity(4200);
		native.processes.set(4200, {
			pid: 4200,
			startTimeTicks: identity.startTimeTicks,
			state: "Z",
			processGroupId: 4200,
		});
		expect(isProcessIdentityAlive(identity)).toBe(false);
		native.processes.delete(4200);
		expect(isProcessIdentityAlive(identity)).toBe(false);
	});

	test("does not convert an unavailable native inspection into a dead-owner decision", () => {
		native.failure = Object.assign(new Error("Native process inspection denied"), { code: "EPERM" });
		expect(() => readProcessIdentity(4200)).toThrow("inspection denied");
		expect(() => isProcessIdentityAlive({ pid: 4200, startTimeTicks: 123 })).toThrow("inspection denied");
	});

	test("reads the native process group without Linux procfs", () => {
		native.processes.set(4200, { pid: 4200, startTimeTicks: 123_456, state: "R", processGroupId: 5300 });
		expect(runtimeProcess.readProcessGroupId(4200)).toBe(5300);
	});

	test("rejects malformed native identity data instead of inventing an identity", () => {
		native.processes.set(4200, { pid: 4200, startTimeTicks: 0, state: "R", processGroupId: 4200 });
		expect(() => readProcessIdentity(4200)).toThrow(/native process information/i);
	});
});
