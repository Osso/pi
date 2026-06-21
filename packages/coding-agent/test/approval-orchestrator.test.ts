import { describe, expect, it, vi } from "vitest";
import { orchestrateToolApproval } from "../src/core/permissions/orchestrator.ts";

describe("orchestrateToolApproval", () => {
	it("routes on-request approvals to the hook reviewer", async () => {
		const reviewer = vi.fn().mockResolvedValue({ block: true, reason: "blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				policy: "on-request",
				reviewer,
			}),
		).resolves.toEqual({ block: true, reason: "blocked" });
		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("blocks never without invoking the hook reviewer", async () => {
		const reviewer = vi.fn().mockResolvedValue(undefined);

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				policy: "never",
				reviewer,
			}),
		).resolves.toEqual({ block: true, reason: "Blocked by approval policy: never" });
		expect(reviewer).not.toHaveBeenCalled();
	});

	it("allows auto-approve without invoking the hook reviewer", async () => {
		const reviewer = vi.fn().mockResolvedValue({ block: true, reason: "blocked" });

		await expect(
			orchestrateToolApproval({
				approvalRequired: true,
				policy: "auto-approve",
				reviewer,
			}),
		).resolves.toBeUndefined();
		expect(reviewer).not.toHaveBeenCalled();
	});
});
