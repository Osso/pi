import { describe, expect, test } from "vitest";
import { isProcessIdentityAlive, readProcessIdentity } from "../src/core/runtime-process.ts";

describe("runtime process identity", () => {
	test("matches a live process only at its exact start time", () => {
		const identity = readProcessIdentity(process.pid);

		expect(identity).toEqual({ pid: process.pid, startTimeTicks: expect.any(Number) });
		expect(identity.startTimeTicks).toBeGreaterThan(0);
		expect(isProcessIdentityAlive(identity)).toBe(true);
		expect(isProcessIdentityAlive({ ...identity, startTimeTicks: identity.startTimeTicks + 1 })).toBe(false);
	});
});
