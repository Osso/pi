import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getSessionsDir } from "../../../src/config.ts";
import { listActiveSessionMetadata } from "../../../src/core/session-control-db.ts";

export interface AttachSessionInfo {
	id: string;
	cwd: string;
	name?: string;
	path: string;
}

async function listDirectory(path: string): Promise<Dirent[]> {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function readSessionHeader(path: string): Promise<AttachSessionInfo | undefined> {
	const stream = createReadStream(path);
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const header: unknown = JSON.parse(line);
			if (!header || typeof header !== "object") return undefined;
			const value = header as { type?: unknown; id?: unknown; cwd?: unknown };
			if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string")
				return undefined;
			return { path, id: value.id, cwd: value.cwd };
		}
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	} finally {
		lines.close();
		stream.destroy();
	}
	return undefined;
}

function readMatchingSessionMetadata(sessionId: string, controlDbPath: string | undefined): AttachSessionInfo[] {
	if (!controlDbPath) return [];
	return listActiveSessionMetadata(controlDbPath)
		.filter((metadata) => metadata.id.startsWith(sessionId))
		.map((metadata) => ({
			id: metadata.id,
			cwd: metadata.cwd,
			name: metadata.name || metadata.subagentName,
			path: metadata.sessionPath,
		}));
}

async function appendMatchingDirectorySessions(
	dir: string,
	sessionId: string,
	sessions: Map<string, AttachSessionInfo>,
): Promise<void> {
	const files = (await listDirectory(dir)).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
	for (const entry of files) {
		const separator = entry.name.indexOf("_");
		if (separator < 0 || !entry.name.slice(separator + 1, -6).startsWith(sessionId)) continue;
		const path = join(dir, entry.name);
		if (sessions.has(path)) continue;
		const session = await readSessionHeader(path);
		if (session?.id.startsWith(sessionId)) sessions.set(path, session);
	}
}

export async function findAttachSessionsById(
	sessionId: string,
	customDir: string | undefined,
	controlDbPath: string | undefined,
): Promise<AttachSessionInfo[]> {
	const indexedSessions = readMatchingSessionMetadata(sessionId, controlDbPath);
	const sessions = new Map(indexedSessions.map((session) => [session.path, session]));
	const root = getSessionsDir();
	const dirs = (await listDirectory(root))
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name));
	if (customDir) dirs.push(customDir);
	for (const dir of new Set(dirs)) {
		await appendMatchingDirectorySessions(dir, sessionId, sessions);
	}
	return [...sessions.values()];
}
