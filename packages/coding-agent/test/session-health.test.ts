import { describe, expect, it } from "vitest";
import {
	emptySessionHealth,
	endSessionHealth,
	isSessionEligibleToReceive,
	isStickyDead,
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
		expect(isStickyDead({ ...health, agentGeneration: 3 })).toBe(false);
	});

	it("ends session health without probing its historical pid", () => {
		const live = {
			...emptySessionHealth("session-a"),
			agentGeneration: 1,
			pid: 1234,
			checkStatus: "ok" as const,
			checkedGeneration: 1,
		};

		const ended = endSessionHealth(live, "2026-01-01T00:00:00.000Z");

		expect(ended).toMatchObject({
			pid: null,
			checkStatus: "dead",
			checkedGeneration: 1,
			lastCheckedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(isSessionEligibleToReceive(ended)).toBe(false);
	});
});
