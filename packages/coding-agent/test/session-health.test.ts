import { describe, expect, it } from "vitest";
import {
	applyProcessCheck,
	emptySessionHealth,
	isSessionEligibleToReceive,
	isStickyDead,
	needsSessionCheck,
	parseGoalObjective,
} from "../src/core/session-health.ts";

describe("session health helpers", () => {
	it("parses goal objectives from JSON payloads", () => {
		expect(parseGoalObjective('{"objective":"ship list_sessions"}')).toBe("ship list_sessions");
		expect(parseGoalObjective("raw goal text")).toBe("raw goal text");
		expect(parseGoalObjective(undefined)).toBeNull();
	});

	it("marks sticky dead only for the same generation", () => {
		const health = {
			...emptySessionHealth("session-a"),
			agentGeneration: 2,
			checkStatus: "dead" as const,
			checkedGeneration: 2,
		};
		expect(isStickyDead(health)).toBe(true);
		expect(needsSessionCheck(health, health.lastActiveAt)).toBe(false);
		expect(isStickyDead({ ...health, agentGeneration: 3 })).toBe(false);
		expect(needsSessionCheck({ ...health, agentGeneration: 3 }, health.lastActiveAt)).toBe(true);
	});

	it("requires checks for never/timeout/stale ok sessions", () => {
		const never = emptySessionHealth("session-a");
		expect(needsSessionCheck(never, null)).toBe(true);

		const timeout = {
			...never,
			checkStatus: "timeout" as const,
			agentGeneration: 1,
			lastCheckedAt: new Date().toISOString(),
		};
		expect(needsSessionCheck(timeout, null)).toBe(true);

		const freshOk = {
			...never,
			checkStatus: "ok" as const,
			agentGeneration: 1,
			checkedGeneration: 1,
			lastCheckedAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
		};
		expect(needsSessionCheck(freshOk, freshOk.lastActiveAt)).toBe(false);

		const staleOk = {
			...freshOk,
			lastCheckedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
			lastActiveAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
		};
		expect(needsSessionCheck(staleOk, staleOk.lastActiveAt)).toBe(true);
	});

	it("applies process checks into sticky dead or ok state", () => {
		const base = {
			...emptySessionHealth("session-a"),
			agentGeneration: 1,
			pid: 1234,
		};
		const dead = applyProcessCheck(base, { pid: 1234, alive: false, nowIso: "2026-01-01T00:00:00.000Z" });
		expect(dead).toMatchObject({
			checkStatus: "dead",
			checkedGeneration: 1,
			lastCheckedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(isSessionEligibleToReceive(dead)).toBe(false);

		const ok = applyProcessCheck(base, { pid: 1234, alive: true, nowIso: "2026-01-01T00:00:01.000Z" });
		expect(ok).toMatchObject({
			checkStatus: "ok",
			checkedGeneration: 1,
			lastCheckedAt: "2026-01-01T00:00:01.000Z",
		});
		expect(isSessionEligibleToReceive(ok)).toBe(true);
	});
});
