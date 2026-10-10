import { hostname } from "node:os";
import { isKnownLocalSession } from "../../../src/core/session-control-db.ts";
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
	if (controlDbPath && params.toSessionId && !isKnownLocalSession(controlDbPath, params.toSessionId)) {
		return `Unknown local session ${params.toSessionId}; pass toHost for a session on another host.`;
	}
	return undefined;
}
