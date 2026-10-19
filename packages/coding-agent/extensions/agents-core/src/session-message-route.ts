import { hostname } from "node:os";
import { isKnownLocalSession, readLiveRuntimeMailboxSessionAgentIds } from "../../../src/core/session-control-db.ts";
import type { SendAgentMessageParams } from "./mailbox-tools.ts";

export function isRemoteSessionMessage(params: SendAgentMessageParams): boolean {
	return params.toHost !== undefined && params.toHost !== hostname();
}

export function sessionMessageRouteError(
	controlDbPath: string | undefined,
	params: SendAgentMessageParams,
): string | undefined {
	if (params.toHost !== undefined && !params.toHost.trim()) return "toHost must be non-empty.";
	if (isRemoteSessionMessage(params)) return params.toSessionId ? undefined : "toHost requires toSessionId.";
	if (!controlDbPath || !params.toSessionId) return undefined;
	if (!isKnownLocalSession(controlDbPath, params.toSessionId)) {
		return `Unknown local session ${params.toSessionId}; pass toHost for a session on another host.`;
	}
	if (params.toAgentId !== "main" && params.toAgentId !== "supervisor") return undefined;
	const agentIds = readLiveRuntimeMailboxSessionAgentIds(controlDbPath, params.toSessionId);
	if (agentIds.length === 0 || agentIds.includes(null)) return undefined;
	return `Session ${params.toSessionId} has child-agent listeners (${agentIds.join(", ")}) but no main-thread listener. Set toAgentId to the intended child agent ID; "main" and "supervisor" address only a main thread.`;
}
