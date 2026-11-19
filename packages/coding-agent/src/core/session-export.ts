import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { loadEntriesFromFile } from "./session-file-reader.ts";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
} from "./session-manager.ts";

/**
 * The current branch from its first entry. A reopened compacted session holds only its active slice in memory, so
 * the ancestors come from the persisted transcript; entries not yet on disk come from memory.
 */
function readFullBranch(sessionManager: SessionManager): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile && existsSync(sessionFile)) {
		for (const entry of loadEntriesFromFile(sessionFile)) if (entry.type !== "session") byId.set(entry.id, entry);
	}
	for (const entry of sessionManager.getEntries()) if (!byId.has(entry.id)) byId.set(entry.id, entry);
	const branch: SessionEntry[] = [];
	for (let entry = byId.get(sessionManager.getLeafId() ?? ""); entry; entry = byId.get(entry.parentId ?? "")) {
		if (branch.includes(entry)) throw new Error(`Session branch has a parent cycle at entry ${entry.id}`);
		branch.push(entry);
	}
	return branch.reverse();
}

/** Write the session header and every entry on the current branch path as linear JSONL. */
export function exportSessionToJsonl(sessionManager: SessionManager, outputPath?: string): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		sessionManager.getCwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: sessionManager.getCwd(),
	};
	const lines = [JSON.stringify(header)];
	// Re-chain parentIds to form a linear sequence
	let parentId: string | null = null;
	for (const entry of readFullBranch(sessionManager)) {
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id;
	}
	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}
