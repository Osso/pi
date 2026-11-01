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

export async function findAttachSessionsById(
	sessionId: string,
	customDir: string | undefined,
	controlDbPath: string | undefined,
): Promise<AttachSessionInfo[]> {
	const sessions = new Map<string, AttachSessionInfo>();
	if (controlDbPath) {
		for (const metadata of listActiveSessionMetadata(controlDbPath)) {
			if (!metadata.id.startsWith(sessionId)) continue;
			sessions.set(metadata.sessionPath, {
				id: metadata.id,
				cwd: metadata.cwd,
				name: metadata.name || metadata.subagentName,
				path: metadata.sessionPath,
			});
		}
	}
	const root = getSessionsDir();
	const dirs = (await listDirectory(root))
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name));
	if (customDir) dirs.push(customDir);
	for (const dir of new Set(dirs)) {
		for (const entry of await listDirectory(dir)) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const separator = entry.name.indexOf("_");
			if (separator < 0 || !entry.name.slice(separator + 1, -6).startsWith(sessionId)) continue;
			const path = join(dir, entry.name);
			if (sessions.has(path)) continue;
			const session = await readSessionHeader(path);
			if (session?.id.startsWith(sessionId)) sessions.set(path, session);
		}
	}
	return [...sessions.values()];
}
