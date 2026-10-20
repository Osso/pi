import { createReadStream, existsSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";

/** Includes archived transcripts, without changing archive state. */
export function isSessionTranscriptFile(path: string): boolean {
	return path.endsWith(".jsonl") || path.endsWith(".jsonl.zst");
}

/** Resolve references persisted before a session was archived. Prefer an existing plain file. */
export function readSessionTranscriptPath(path: string): string {
	return !existsSync(path) && path.endsWith(".jsonl") && existsSync(`${path}.zst`) ? `${path}.zst` : path;
}

export function readSessionTranscriptBytes(path: string): Buffer {
	const source = readSessionTranscriptPath(path);
	const bytes = readFileSync(source);
	return source.endsWith(".jsonl.zst") ? zstdDecompressSync(bytes) : bytes;
}

export function readSessionTranscriptText(path: string): string {
	return readSessionTranscriptBytes(path).toString("utf8");
}

/** Streaming readers propagate source/decompression errors and decode split UTF-8 characters. */
export function createSessionTranscriptReadStream(path: string): Readable {
	const source = readSessionTranscriptPath(path);
	const input = createReadStream(source);
	const decoded = source.endsWith(".jsonl.zst") ? input.compose(createZstdDecompress()) : input;
	decoded.setEncoding("utf8");
	return decoded;
}
