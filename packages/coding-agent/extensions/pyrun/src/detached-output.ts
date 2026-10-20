import { writeFileSync } from "node:fs";
import type { PyrunArtifactRecord } from "./detached-progress.ts";
import type { CanonicalPyrunProgressUpdate } from "./runner.ts";

const OUTPUT_BYTE_LIMIT = 50 * 1024 * 1024;
const HEAD_BYTE_LIMIT = OUTPUT_BYTE_LIMIT / 2;
// Covers the JSON marker, its message, and two decimal counters.
const TRUNCATION_MARKER_BYTE_RESERVE = 256;

type TerminalRecord = Extract<PyrunArtifactRecord, { kind: "result" | "error" }>;

/** Append-only: readers' existing byte offsets remain valid until settlement. */
export class PyrunArtifactWriter {
	private readonly path: string;
	private headBytes = 0;
	private buffering = false;
	private readonly tail = new Map<number, Buffer>();
	private nextRecord = 0;
	private tailBytes = 0;
	private omittedBytes = 0;
	private omittedRecords = 0;

	constructor(path: string) {
		this.path = path;
	}

	appendProgress(update: CanonicalPyrunProgressUpdate): void {
		const bytes = Buffer.from(`${JSON.stringify({ kind: "progress", update })}\n`);
		if (!this.buffering && this.headBytes + bytes.length <= HEAD_BYTE_LIMIT) {
			this.appendBytes(bytes);
			this.headBytes += bytes.length;
			return;
		}
		this.buffering = true;
		this.tail.set(this.nextRecord++, bytes);
		this.tailBytes += bytes.length;
		this.dropOldestTailRecords(OUTPUT_BYTE_LIMIT - this.headBytes);
	}

	finish(record: TerminalRecord): void {
		const terminal = Buffer.from(`${JSON.stringify(record)}\n`);
		const remainingBytes = OUTPUT_BYTE_LIMIT - this.headBytes - terminal.length;
		if (this.omittedRecords > 0 || this.tailBytes > remainingBytes) {
			this.dropOldestTailRecords(Math.max(0, remainingBytes - TRUNCATION_MARKER_BYTE_RESERVE));
		}
		if (this.omittedRecords > 0) this.appendTruncationMarker();
		for (const bytes of this.tail.values()) this.appendBytes(bytes);
		this.tail.clear();
		this.tailBytes = 0;
		// Mandatory terminal data wins even when head + terminal exceeds the cap.
		this.appendBytes(terminal);
	}

	private dropOldestTailRecords(byteLimit: number): void {
		while (this.tailBytes > byteLimit) {
			const oldest = this.tail.entries().next().value;
			if (!oldest) break;
			const [key, bytes] = oldest;
			this.tail.delete(key);
			this.tailBytes -= bytes.length;
			this.omittedBytes += bytes.length;
			this.omittedRecords++;
		}
	}

	private appendTruncationMarker(): void {
		const record: PyrunArtifactRecord = {
			kind: "truncation",
			message: "Middle progress records omitted from capped Pyrun output.",
			omittedBytes: this.omittedBytes,
			omittedRecords: this.omittedRecords,
		};
		this.appendBytes(Buffer.from(`${JSON.stringify(record)}\n`));
	}

	private appendBytes(bytes: Buffer): void {
		writeFileSync(this.path, bytes, { flag: "a", mode: 0o600 });
	}
}
