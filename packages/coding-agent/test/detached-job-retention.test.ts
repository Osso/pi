import { describe, expect, it } from "vitest";
import {
	type DetachedArtifactRetentionCandidate,
	selectDetachedArtifactDirectoriesToDelete,
} from "../src/core/detached-job-retention.ts";

const now = 10_000;

function candidate(
	directoryPath: string,
	byteSize: number,
	terminalAt: number,
	protectedByLiveReference = false,
): DetachedArtifactRetentionCandidate {
	return { byteSize, directoryPath, protectedByLiveReference, terminalAt };
}

describe("detached artifact retention selector", () => {
	it("selects every unprotected artifact at or beyond the maximum age", () => {
		const candidates = [
			candidate("/jobs/recent", 10, 9_001),
			candidate("/jobs/boundary", 20, 9_000),
			candidate("/jobs/old", 30, 8_000),
			candidate("/jobs/protected-old", 40, 8_000, true),
		];

		expect(
			selectDetachedArtifactDirectoriesToDelete(candidates, {
				maxAge: 1_000,
				maxBytes: 1_000,
				now,
			}),
		).toEqual(["/jobs/old", "/jobs/boundary"]);
	});

	it("then selects oldest unprotected artifacts until retained bytes reach the cap", () => {
		const candidates = [
			candidate("/jobs/newest", 30, 9_900),
			candidate("/jobs/oldest", 30, 9_700),
			candidate("/jobs/middle", 30, 9_800),
			candidate("/jobs/protected", 50, 9_600, true),
		];

		expect(
			selectDetachedArtifactDirectoriesToDelete(candidates, {
				maxAge: 10_000,
				maxBytes: 90,
				now,
			}),
		).toEqual(["/jobs/oldest", "/jobs/middle"]);
	});

	it("uses directory path as a deterministic tie-break for equal timestamps", () => {
		const candidates = [candidate("/jobs/z", 10, 9_500), candidate("/jobs/a", 10, 9_500)];

		expect(
			selectDetachedArtifactDirectoriesToDelete(candidates, {
				maxAge: 10_000,
				maxBytes: 10,
				now,
			}),
		).toEqual(["/jobs/a"]);
	});

	it("returns no protected paths even when protected bytes exceed the cap", () => {
		const candidates = [candidate("/jobs/protected", 200, 0, true), candidate("/jobs/keep", 10, 9_900)];

		expect(
			selectDetachedArtifactDirectoriesToDelete(candidates, {
				maxAge: 1_000,
				maxBytes: 100,
				now,
			}),
		).toEqual(["/jobs/keep"]);
	});

	it.each([
		["candidate byte size", [candidate("/jobs/a", Number.NaN, 0)], { maxAge: 1, maxBytes: 1, now }],
		["now", [], { maxAge: 1, maxBytes: 1, now: -1 }],
		["maximum age", [], { maxAge: Number.POSITIVE_INFINITY, maxBytes: 1, now }],
		["maximum bytes", [], { maxAge: 1, maxBytes: -1, now }],
	] as const)("rejects invalid nonnegative finite %s values", (_name, candidates, policy) => {
		expect(() => selectDetachedArtifactDirectoriesToDelete(candidates, policy)).toThrow(/nonnegative finite/);
	});
});
