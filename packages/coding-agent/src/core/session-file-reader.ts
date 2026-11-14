import { closeSync, existsSync, openSync, readSync } from "fs";
import { StringDecoder } from "string_decoder";
import { normalizePath } from "../utils/paths.ts";
import { isArchivedSessionFile } from "./session-archive-storage.ts";
import type { FileEntry } from "./session-manager.ts";
import { readSessionTranscriptPath } from "./session-transcript.ts";
import { withSeekableSessionTranscript } from "./session-transcript-spool.ts";

export const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

export function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// Skip malformed lines
		return null;
	}
}

/** Load persisted entries without migration or writes. */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = readSessionTranscriptPath(normalizePath(filePath));
	if (!existsSync(resolvedFilePath)) return [];
	if (isArchivedSessionFile(resolvedFilePath)) {
		return withSeekableSessionTranscript(resolvedFilePath, loadEntriesFromFile);
	}

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const line = pending.slice(lineStart, newlineIndex);
				const entry = parseSessionEntryLine(line);
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header === undefined) throw new Error("session header missing");
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}
