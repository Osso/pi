import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { isPiRuntimeProcessAlive } from "./runtime-process.ts";
import { listActiveSessionMetadata, readSessionHealth, removeSessionMetadata } from "./session-control-db.ts";
import type { SessionManager } from "./session-manager.ts";

function isResidentSession(sessionId: string, sessionPath: string): boolean {
	return (
		sessionId === "supervisor" ||
		sessionId === "architect" ||
		/(?:^|[\\/])(?:supervisor-sessions|architect-sessions)(?:[\\/]|$)/.test(sessionPath)
	);
}

function hasMessageEntry(sessionManager: SessionManager): boolean {
	return sessionManager.getEntries().some((entry) => entry.type === "message");
}

export function removeAbandonedEmptySession(sessionManager: SessionManager, targetSessionFile?: string): void {
	const controlDbPath = sessionManager.getMetadataControlDbPath();
	const sessionFile = sessionManager.getSessionFile();
	if (!controlDbPath || !sessionFile) return;
	if (targetSessionFile && resolve(targetSessionFile) === resolve(sessionFile)) return;
	if (isResidentSession(sessionManager.getSessionId(), sessionFile) || hasMessageEntry(sessionManager)) return;

	removeSessionMetadata(controlDbPath, sessionFile);
	if (existsSync(sessionFile)) unlinkSync(sessionFile);
}

export function sweepAbandonedEmptySessions(controlDbPath: string): number {
	const sessions = listActiveSessionMetadata(controlDbPath);
	const abandonedSessions = sessions.filter((session) => {
		if (session.isSubagent || session.messageCount !== 0 || isResidentSession(session.id, session.sessionPath)) {
			return false;
		}
		if (existsSync(session.sessionPath)) return false;
		const health = readSessionHealth(controlDbPath, session.id);
		return !health?.pid || !isPiRuntimeProcessAlive(health.pid);
	});

	for (const session of abandonedSessions) {
		removeSessionMetadata(controlDbPath, session.sessionPath);
	}
	return abandonedSessions.length;
}
