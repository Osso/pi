import { describe, expect, it } from "vitest";
import { type ApprovalPolicy, evaluateApprovalPolicy, isApprovalPolicy } from "../src/core/permissions/policy.ts";

describe("ApprovalPolicy", () => {
	it("accepts only distinct supported policy presets", () => {
		const policies: ApprovalPolicy[] = ["on-request", "never", "auto-approve"];

		expect(policies.every(isApprovalPolicy)).toBe(true);
		expect(isApprovalPolicy("always")).toBe(false);
		expect(new Set(policies).size).toBe(3);
	});

	it("routes approval-required actions for on-request review", () => {
		expect(evaluateApprovalPolicy("on-request", { approvalRequired: true })).toEqual({ action: "review" });
	});

	it("rejects approval-required actions for never without reviewer involvement", () => {
		expect(evaluateApprovalPolicy("never", { approvalRequired: true })).toEqual({
			action: "block",
			reason: "Blocked by approval policy: never",
		});
	});

	it("approves approval-required actions for auto-approve without reviewer involvement", () => {
		expect(evaluateApprovalPolicy("auto-approve", { approvalRequired: true })).toEqual({ action: "allow" });
	});

	it("allows actions that do not require approval for every policy", () => {
		for (const policy of ["on-request", "never", "auto-approve"] as const) {
			expect(evaluateApprovalPolicy(policy, { approvalRequired: false })).toEqual({ action: "allow" });
		}
	});
});
