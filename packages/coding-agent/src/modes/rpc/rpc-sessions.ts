/**
 * `list_sessions` for RPC clients: the sessions the TUI's `/resume` picker
 * offers, for the current project (`scope: "cwd"`, default) or all projects.
 */

import { getControlDbPath } from "../../core/session-control-db.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import type { RpcResponse, RpcSessionSummary } from "./rpc-types.ts";

function toSummary(session: SessionInfo): RpcSessionSummary {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
	};
}

export async function listRpcSessions(
	command: { id?: string; scope?: "cwd" | "all" },
	sessionManager: SessionManager,
	runtimeHost: { services?: { agentDir?: string } },
): Promise<RpcResponse> {
	const controlDbPath = runtimeHost.services?.agentDir ? getControlDbPath() : undefined;
	const sessionDir = sessionManager.usesDefaultSessionDir() ? undefined : sessionManager.getSessionDir();
	const sessions =
		command.scope === "all"
			? await SessionManager.listAll(sessionDir, undefined, controlDbPath)
			: await SessionManager.list(sessionManager.getCwd(), sessionManager.getSessionDir(), undefined, controlDbPath);
	return {
		id: command.id,
		type: "response",
		command: "list_sessions",
		success: true,
		data: { sessions: sessions.map(toSummary) },
	};
}
