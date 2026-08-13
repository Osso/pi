import {
	cancelSupervisorRequest,
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorResponse,
} from "../core/session-control-db.ts";
import { ensureSupervisorRunning } from "./ensure-running.ts";
import { notifySupervisorRequest } from "./request-wake.ts";

export const SUPERVISOR_REQUEST_CANCELLED_REASON = "Supervisor request cancelled";

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
	signal?: AbortSignal;
}

export interface SupervisorClientDependencies {
	ensureRunning?: (input: { controlDbPath: string }) => Promise<unknown>;
}

async function requestSupervisorDecisionAttempt(
	input: RequestSupervisorDecisionInput,
	dependencies: Required<SupervisorClientDependencies>,
): Promise<SupervisorResponse | undefined> {
	if (input.signal?.aborted) return { kind: "error", reason: SUPERVISOR_REQUEST_CANCELLED_REASON };
	try {
		await dependencies.ensureRunning({ controlDbPath: input.controlDbPath });
	} catch (error) {
		return {
			kind: "error",
			reason: `Supervisor startup failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const deadline = Date.now() + input.timeoutMs;
	if (input.signal?.aborted) return { kind: "error", reason: SUPERVISOR_REQUEST_CANCELLED_REASON };
	const requestId = postSupervisorRequest(input.controlDbPath, {
		deadlineAt: new Date(deadline).toISOString(),
		kind: input.kind,
		payload: input.payload,
		projectId: input.projectId,
		senderSessionId: input.senderSessionId,
	});
	const cancelRequest = (): void => {
		if (cancelSupervisorRequest(input.controlDbPath, requestId, input.senderSessionId, SUPERVISOR_REQUEST_CANCELLED_REASON)) {
			notifySupervisorRequest(input.controlDbPath);
		}
	};
	const onAbort = (): void => cancelRequest();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		notifySupervisorRequest(input.controlDbPath);
		const pollIntervalMs = input.pollIntervalMs ?? 50;
		while (Date.now() < deadline) {
			if (input.signal?.aborted) {
				cancelRequest();
				return { kind: "error", reason: SUPERVISOR_REQUEST_CANCELLED_REASON };
			}
			const request = readSupervisorRequest(input.controlDbPath, requestId);
			if (request?.status === "completed" && request.response) return request.response;
			if (request?.status === "cancelled") {
				return { kind: "error", reason: request.response?.kind === "error" ? request.response.reason : SUPERVISOR_REQUEST_CANCELLED_REASON };
			}
			if (!(await delay(pollIntervalMs, input.signal))) {
				cancelRequest();
				return { kind: "error", reason: SUPERVISOR_REQUEST_CANCELLED_REASON };
			}
		}
		return undefined;
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
	}
}

function retryDelay(input: RequestSupervisorDecisionInput, attempt: number): number {
	const baseDelayMs = input.retryDelayMs ?? 1_000;
	const jitterRatio = input.retryJitterRatio ?? 0.2;
	const exponentialDelayMs = baseDelayMs * 2 ** (attempt - 1);
	return exponentialDelayMs * (1 - jitterRatio + Math.random() * jitterRatio * 2);
}

export async function requestSupervisorDecision(
	input: RequestSupervisorDecisionInput,
	dependencies: SupervisorClientDependencies = {},
): Promise<SupervisorResponse> {
	const resolvedDependencies = { ensureRunning: dependencies.ensureRunning ?? ensureSupervisorRunning };
	const maxAttempts = input.maxAttempts ?? 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const response = await requestSupervisorDecisionAttempt(input, resolvedDependencies);
		if (response) return response;
		if (attempt < maxAttempts && !(await delay(retryDelay(input, attempt), input.signal))) {
			return { kind: "error", reason: SUPERVISOR_REQUEST_CANCELLED_REASON };
		}
	}
	const suffix = maxAttempts === 1 ? "" : ` after ${maxAttempts} attempts`;
	return { kind: "error", reason: `Supervisor request timed out${suffix}` };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (completed: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(completed);
		};
		const onAbort = (): void => finish(false);
		const timer = setTimeout(() => finish(true), milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
