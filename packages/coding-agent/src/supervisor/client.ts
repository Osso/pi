import { randomUUID } from "node:crypto";
import type { SupervisorRequestKind, SupervisorResponse } from "../core/session-control-db.ts";
import { ensureSupervisorAvailable } from "./ensure-running.ts";
import {
	cancelSubmittedSupervisorRequest,
	type SupervisorAddress,
	submitSupervisorRequest,
	watchSupervisorReplies,
} from "./mail.ts";

export const SUPERVISOR_REQUEST_CANCELLED_REASON = "Supervisor request cancelled";
export const DEFAULT_SUPERVISOR_POLL_INTERVAL_MS = 300;

export interface RequestSupervisorDecisionInput {
	controlDbPath: string;
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	projectId: string;
	senderSessionId: string;
	/** The asking child agent; replies go to its mailbox. Omit for a main session. */
	senderAgentId?: string | null;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface SupervisorClientDependencies {
	ensureRunning?: (input: { controlDbPath: string }) => Promise<SupervisorAddress>;
}

function cancelledResponse(): SupervisorResponse {
	return { kind: "error", reason: SUPERVISOR_REQUEST_CANCELLED_REASON };
}

/**
 * Submits one request and waits for the Supervisor's reply in this runtime's mailbox until the deadline.
 * The caller never reads the queue row, so local and remote Supervisors answer the same way.
 */
export async function requestSupervisorDecision(
	input: RequestSupervisorDecisionInput,
	dependencies: SupervisorClientDependencies = {},
): Promise<SupervisorResponse> {
	if (input.signal?.aborted) return cancelledResponse();
	let supervisor: SupervisorAddress;
	try {
		supervisor = await (dependencies.ensureRunning ?? ensureSupervisorAvailable)({
			controlDbPath: input.controlDbPath,
		});
	} catch (error) {
		return {
			kind: "error",
			reason: `Supervisor startup failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (input.signal?.aborted) return cancelledResponse();
	const route = {
		sessionId: input.senderSessionId,
		agentId: input.senderAgentId ?? null,
		requestId: randomUUID(),
	};
	return new Promise<SupervisorResponse>((resolve) => {
		const finish = (response: SupervisorResponse) => {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			stopWatching();
			resolve(response);
		};
		const onAbort = () => {
			cancelSubmittedSupervisorRequest(input.controlDbPath, supervisor, route, SUPERVISOR_REQUEST_CANCELLED_REASON);
			finish(cancelledResponse());
		};
		const timer = setTimeout(
			() => finish({ kind: "error", reason: "Supervisor request timed out" }),
			input.timeoutMs,
		);
		const stopWatching = watchSupervisorReplies(input.controlDbPath, route, (reply) =>
			finish(
				reply.response.kind === "inspection"
					? { kind: "error", reason: "Unexpected session inspection reply" }
					: reply.response,
			),
		);
		input.signal?.addEventListener("abort", onAbort, { once: true });
		submitSupervisorRequest(input.controlDbPath, supervisor, {
			deadlineAt: new Date(Date.now() + input.timeoutMs).toISOString(),
			kind: input.kind,
			payload: input.payload,
			projectId: input.projectId,
			replyTo: route,
		});
	});
}
