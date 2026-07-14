import {
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorResponse,
} from "../core/session-control-db.ts";

export interface RequestSupervisorDecisionInput {
	controlDbPath: string;
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	projectId: string;
	senderSessionId: string;
	timeoutMs: number;
	pollIntervalMs?: number;
}

export async function requestSupervisorDecision(input: RequestSupervisorDecisionInput): Promise<SupervisorResponse> {
	const deadline = Date.now() + input.timeoutMs;
	const requestId = postSupervisorRequest(input.controlDbPath, {
		deadlineAt: new Date(deadline).toISOString(),
		kind: input.kind,
		payload: input.payload,
		projectId: input.projectId,
		senderSessionId: input.senderSessionId,
	});
	const pollIntervalMs = input.pollIntervalMs ?? 50;
	while (Date.now() < deadline) {
		const request = readSupervisorRequest(input.controlDbPath, requestId);
		if (request?.status === "completed" && request.response) return request.response;
		await delay(pollIntervalMs);
	}
	return { kind: "error", reason: "Supervisor request timed out" };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
