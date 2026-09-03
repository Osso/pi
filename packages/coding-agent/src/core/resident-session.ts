import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isPiRuntimeProcessAlive } from "./runtime-process.ts";
import { listSessionMetadata, readRuntimeMailboxListener, removeSessionMetadata } from "./session-control-db.ts";

export type ResidentRole = "architect" | "supervisor";

export function isResidentSession(session: { id: string; path: string }): boolean {
	return (
		session.id === "supervisor" ||
		session.id === "architect" ||
		/(?:^|[\\/])(?:supervisor-sessions|architect-sessions)(?:[\\/]|$)/.test(session.path)
	);
}

export function prepareResidentSessionFile(
	agentDir: string,
	role: ResidentRole,
	controlDbPath: string,
): { sessionDir: string; sessionPath: string } {
	const sessionDir = join(agentDir, `${role}-sessions`);
	mkdirSync(sessionDir, { recursive: true });
	const canonicalFile = `${role}.jsonl`;
	const matchingFiles = readdirSync(sessionDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && (entry.name === canonicalFile || entry.name.endsWith(`_${canonicalFile}`)))
		.map((entry) => entry.name);
	const liveSessionPath = findLiveResidentSessionPath(controlDbPath, role, sessionDir);
	const liveFile = liveSessionPath ? basename(liveSessionPath) : undefined;
	if (liveFile && !matchingFiles.includes(liveFile)) matchingFiles.push(liveFile);
	const latestFile = matchingFiles
		.filter((file) => file.endsWith(`_${canonicalFile}`))
		.sort()
		.at(-1);
	const retainedFile = liveFile ?? latestFile ?? canonicalFile;
	for (const file of matchingFiles) {
		if (file === retainedFile) continue;
		const stalePath = join(sessionDir, file);
		removeSessionMetadata(controlDbPath, stalePath);
		unlinkSync(stalePath);
	}
	for (const metadata of listSessionMetadata(controlDbPath)) {
		if (!isResidentSessionForRole(metadata, role) || metadata.sessionPath === liveSessionPath) continue;
		if (!existsSync(metadata.sessionPath)) removeSessionMetadata(controlDbPath, metadata.sessionPath);
	}
	return { sessionDir, sessionPath: join(sessionDir, retainedFile) };
}

function findLiveResidentSessionPath(
	controlDbPath: string,
	role: ResidentRole,
	sessionDir: string,
): string | undefined {
	const listener = readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: role });
	if (!listener?.sessionPath || !isPiRuntimeProcessAlive(listener.pid)) return undefined;
	const sessionPath = resolve(listener.sessionPath);
	return dirname(sessionPath) === resolve(sessionDir) && sessionPath.endsWith(".jsonl") ? sessionPath : undefined;
}

function isResidentSessionForRole(session: { id: string; sessionPath: string }, role: ResidentRole): boolean {
	return session.id === role || new RegExp(`(?:^|[\\/])${role}-sessions(?:[\\/]|$)`).test(session.sessionPath);
}
