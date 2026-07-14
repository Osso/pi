import { describe, expect, it, vi } from "vitest";
import { reviewToolCallWithSupervisor } from "../src/supervisor/approval-reviewer.ts";

describe("Supervisor approval reviewer", () => {
	it("allows approved calls and blocks rejected calls", async () => {
		await expect(
			reviewToolCallWithSupervisor(vi.fn(async () => ({ kind: "approve" as const, reason: "bounded" }))),
		).resolves.toBeUndefined();
		await expect(
			reviewToolCallWithSupervisor(vi.fn(async () => ({ kind: "reject" as const, reason: "unsafe" }))),
		).resolves.toEqual({ block: true, reason: "unsafe" });
	});

	it("escalates Supervisor errors to the human reviewer", async () => {
		const askHuman = vi.fn(async () => undefined);

		await expect(
			reviewToolCallWithSupervisor(
				vi.fn(async () => ({ kind: "error" as const, reason: "service unavailable" })),
				askHuman,
			),
		).resolves.toBeUndefined();
		expect(askHuman).toHaveBeenCalledWith("service unavailable");
	});

	it("escalates rejection only for the ask preset", async () => {
		const askHuman = vi.fn(async () => ({ block: true as const, reason: "user denied" }));

		await expect(
			reviewToolCallWithSupervisor(
				vi.fn(async () => ({ kind: "reject" as const, reason: "high risk" })),
				askHuman,
				true,
			),
		).resolves.toEqual({ block: true, reason: "user denied" });
	});
});
