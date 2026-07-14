import type { ToolCallEventResult } from "../core/extensions/types.ts";
import type { SupervisorResponse } from "../core/session-control-db.ts";

export type SupervisorApprovalCall = () => Promise<SupervisorResponse>;
export type SupervisorHumanReviewer = (reason: string) => Promise<ToolCallEventResult | undefined>;

export async function reviewToolCallWithSupervisor(
	requestDecision: SupervisorApprovalCall,
	askHuman?: SupervisorHumanReviewer,
	escalateRejection = false,
): Promise<ToolCallEventResult | undefined> {
	const decision = await requestDecision();
	if (decision.kind === "approve") return undefined;
	if (decision.kind === "reject") {
		return escalateRejection && askHuman ? askHuman(decision.reason) : { block: true, reason: decision.reason };
	}
	const reason = decision.kind === "error" ? decision.reason : "Supervisor returned an invalid approval response";
	return askHuman ? askHuman(reason) : { block: true, reason };
}
