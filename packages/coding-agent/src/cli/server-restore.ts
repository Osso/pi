import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

/** A session a server worker owns: a restarted server reopens it in `cwd`. */
export type OwnedSession = { sessionId: string; cwd: string };

function ownedSessionsPath(): string {
	return join(getAgentDir(), "server-sessions.json");
}

function isOwnedSession(value: unknown): value is OwnedSession {
	const session = value as Partial<OwnedSession> | null;
	return typeof session?.sessionId === "string" && typeof session.cwd === "string";
}

/**
 * The sessions the server owned when it last ran. A file that is not a list of
 * `{ sessionId, cwd }` (edited by hand, truncated) is reported and read as empty;
 * the next change rewrites it.
 */
export function readOwnedSessions(): OwnedSession[] {
	const path = ownedSessionsPath();
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const sessions: unknown = JSON.parse(text);
		if (Array.isArray(sessions) && sessions.every(isOwnedSession)) return sessions;
	} catch {}
	console.error(`pi server: ignoring ${path}: not a list of { sessionId, cwd }`);
	return [];
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
