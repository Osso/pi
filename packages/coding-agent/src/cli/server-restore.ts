import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

/** A session a server worker owns: a restarted server reopens it in `cwd`. */
export type OwnedSession = { sessionId: string; cwd: string };

function ownedSessionsPath(): string {
	return join(getAgentDir(), "server-sessions.json");
}

/** The sessions the server owned when it last ran. */
export function readOwnedSessions(): OwnedSession[] {
	try {
		return JSON.parse(readFileSync(ownedSessionsPath(), "utf8")) as OwnedSession[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function writeOwnedSessions(sessions: OwnedSession[]): void {
	const path = ownedSessionsPath();
	writeFileSync(`${path}.tmp`, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

export function rememberOwnedSession(session: OwnedSession): void {
	writeOwnedSessions([...readOwnedSessions().filter((s) => s.sessionId !== session.sessionId), session]);
}

export function forgetOwnedSession(sessionId: string): void {
	const sessions = readOwnedSessions();
	if (sessions.some((s) => s.sessionId === sessionId))
		writeOwnedSessions(sessions.filter((s) => s.sessionId !== sessionId));
}
