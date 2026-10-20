import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FileEntry, ReadonlySessionManager, SessionEntry } from "./session-manager.ts";
import { createSessionTranscriptReadStream, readSessionTranscriptPath } from "./session-transcript.ts";

const READ_BUFFER_SIZE = 64 * 1024;

function parseEntry(line: string): SessionEntry | undefined {
	if (!line.trim()) return undefined;
	try {
		const entry = JSON.parse(line) as FileEntry;
		return entry.type === "session" ? undefined : entry;
	} catch {
		// Match the transcript loader's handling of incomplete or malformed lines.
		return undefined;
	}
}

/** Read one record at a time; memory is bounded by the chunk and largest record. */
async function* readPlainEntriesReverse(path: string): AsyncGenerator<SessionEntry> {
	const file = await open(path, "r");
	try {
		let position = (await file.stat()).size;
		let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		while (position > 0) {
			const size = Math.min(READ_BUFFER_SIZE, position);
			position -= size;
			const buffer = Buffer.allocUnsafe(size);
			const { bytesRead } = await file.read(buffer, 0, size, position);
			pending = Buffer.concat([buffer.subarray(0, bytesRead), pending]);
			let end = pending.length;
			let newline = pending.lastIndexOf(0x0a, end - 1);
			while (newline !== -1) {
				const entry = parseEntry(pending.subarray(newline + 1, end).toString("utf8"));
				if (entry) yield entry;
				end = newline;
				if (end === 0) break;
				newline = pending.lastIndexOf(0x0a, end - 1);
			}
			pending = pending.subarray(0, end);
		}
		const entry = parseEntry(pending.toString("utf8"));
		if (entry) yield entry;
	} finally {
		await file.close();
	}
}

async function* readTranscriptEntriesReverse(path: string): AsyncGenerator<SessionEntry> {
	const source = readSessionTranscriptPath(path);
	if (!source.endsWith(".jsonl.zst")) {
		yield* readPlainEntriesReverse(source);
		return;
	}
	// Compressed streams cannot be sought backwards. Spool to disk, never a full string/Buffer.
	const directory = await mkdtemp(join(tmpdir(), "pi-history-"));
	try {
		const plain = join(directory, "transcript.jsonl");
		await pipeline(createSessionTranscriptReadStream(source), createWriteStream(plain));
		yield* readPlainEntriesReverse(plain);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Search-only traversal, newest first. Never installs historical entries in model context. */
export async function* readSessionHistoryReverse(manager: ReadonlySessionManager): AsyncGenerator<SessionEntry> {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) yield branch[index];
	let parentId = branch[0]?.parentId;
	const path = manager.getSessionFile();
	if (!parentId || !path) return;
	for await (const entry of readTranscriptEntriesReverse(path)) {
		if (entry.id !== parentId) continue;
		yield entry;
		parentId = entry.parentId;
		if (!parentId) return;
	}
}
