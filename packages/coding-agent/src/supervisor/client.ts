import {
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorResponse,
} from "../core/session-control-db.ts";
import { notifySupervisorRequest } from "./request-wake.ts";

export interface RequestSupervisorDecisionInput {
	controlDbPath: string;
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	projectId: string;
	senderSessionId: string;
	timeoutMs: number;
	maxAttempts?: number;
	pollIntervalMs?: number;
	retryDelayMs?: number;
	retryJitterRatio?: number;
}

async function requestSupervisorDecisionAttempt(
	input: RequestSupervisorDecisionInput,
): Promise<SupervisorResponse | undefined> {
	const deadline = Date.now() + input.timeoutMs;
	const requestId = postSupervisorRequest(input.controlDbPath, {
		deadlineAt: new Date(deadline).toISOString(),
		kind: input.kind,
		payload: input.payload,
		projectId: input.projectId,
		senderSessionId: input.senderSessionId,
	});
	notifySupervisorRequest(input.controlDbPath);
	const pollIntervalMs = input.pollIntervalMs ?? 50;
	while (Date.now() < deadline) {
		const request = readSupervisorRequest(input.controlDbPath, requestId);
		if (request?.status === "completed" && request.response) return request.response;
		await delay(pollIntervalMs);
	}
	return undefined;
}

function retryDelay(input: RequestSupervisorDecisionInput, attempt: number): number {
	const baseDelayMs = input.retryDelayMs ?? 1_000;
	const jitterRatio = input.retryJitterRatio ?? 0.2;
	const exponentialDelayMs = baseDelayMs * 2 ** (attempt - 1);
	return exponentialDelayMs * (1 - jitterRatio + Math.random() * jitterRatio * 2);
}

export async function requestSupervisorDecision(input: RequestSupervisorDecisionInput): Promise<SupervisorResponse> {
	const maxAttempts = input.maxAttempts ?? 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const response = await requestSupervisorDecisionAttempt(input);
		if (response) return response;
		if (attempt < maxAttempts) await delay(retryDelay(input, attempt));
	}
	const suffix = maxAttempts === 1 ? "" : ` after ${maxAttempts} attempts`;
	return { kind: "error", reason: `Supervisor request timed out${suffix}` };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
