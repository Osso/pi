export const APPROVAL_POLICIES = ["on-request", "never", "auto-approve"] as const;

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export type ApprovalPolicyDecision = { action: "allow" } | { action: "review" } | { action: "block"; reason: string };

export type ApprovalPolicyContext = {
	approvalRequired: boolean;
};

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
	return typeof value === "string" && APPROVAL_POLICIES.includes(value as ApprovalPolicy);
}

export function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
	return isApprovalPolicy(value) ? value : "on-request";
}

export function evaluateApprovalPolicy(policy: ApprovalPolicy, context: ApprovalPolicyContext): ApprovalPolicyDecision {
	if (!context.approvalRequired) {
		return { action: "allow" };
	}

	if (policy === "never") {
		return { action: "block", reason: "Blocked by approval policy: never" };
	}

	if (policy === "auto-approve") {
		return { action: "allow" };
	}

	return { action: "review" };
}
