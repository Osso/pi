import type { ToolCallEventResult } from "../extensions/types.ts";
import { type ApprovalPolicy, evaluateApprovalPolicy } from "./policy.ts";

export type ApprovalReviewer = () => Promise<ToolCallEventResult | undefined>;

export type ApprovalOrchestratorOptions = {
	policy: ApprovalPolicy;
	approvalRequired: boolean;
	reviewer?: ApprovalReviewer;
	hookReviewer?: ApprovalReviewer;
	llmReviewer?: ApprovalReviewer;
};

export async function orchestrateToolApproval(
	options: ApprovalOrchestratorOptions,
): Promise<ToolCallEventResult | undefined> {
	const decision = evaluateApprovalPolicy(options.policy, {
		approvalRequired: options.approvalRequired,
	});

	if (decision.action === "allow") {
		return undefined;
	}

	if (decision.action === "block") {
		return { block: true, reason: decision.reason };
	}

	if (options.hookReviewer) {
		return options.hookReviewer();
	}

	if (options.llmReviewer) {
		return options.llmReviewer();
	}

	return options.reviewer?.();
}
