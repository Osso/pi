import {
	completeSupervisorRequest,
	registerRuntimeMailboxListener,
	type SupervisorRequest,
	type SupervisorResponse,
} from "../../src/core/session-control-db.ts";
import { sendSupervisorReply } from "../../src/supervisor/mail.ts";

/**
 * Completes a claimed request and replies the way the Supervisor does. In-process callers have no live
 * session listener, so the asker is registered as this process to receive the mailbox signal.
 */
export function replyAsSupervisor(
	controlDbPath: string,
	request: SupervisorRequest,
	response: SupervisorResponse,
): void {
	if (!request.claimToken || !request.replyTo) throw new Error(`Supervisor request ${request.id} is not claimed`);
	completeSupervisorRequest(controlDbPath, request.id, request.claimToken, response);
	const { sessionId, agentId } = request.replyTo;
	registerRuntimeMailboxListener(controlDbPath, { sessionId, agentId }, process.pid);
	sendSupervisorReply(controlDbPath, "test-supervisor", request.replyTo, { requestKind: request.kind, response });
}
