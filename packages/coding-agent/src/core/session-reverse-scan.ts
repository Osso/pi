import { readSync } from "fs";
import { parseSessionEntryLine, SESSION_READ_BUFFER_SIZE } from "./session-file-reader.ts";
import type { CompactionEntry, FileEntry, SessionEntry } from "./session-manager.ts";

/**
 * Reverse scan of a current-version session file: reads from the end and stops at the latest
 * compaction's first kept entry, so opening a long session loads only its active slice.
 */
interface ReverseSessionScan {
	activePath: SessionEntry[];
	hasInactiveEntries: boolean;
	isReadingLeaf: boolean;
	requiredParentId: string | null;
	latestCompaction: CompactionEntry | undefined;
	foundFirstKeptEntry: boolean;
	precedingCwd: string | undefined;
	allowIncompleteTrailingEntry: boolean;
}

export interface LoadedSessionEntries {
	entries: SessionEntry[];
	precedingCwd?: string;
	hasActiveSlice: boolean;
}

interface ReverseLineScanResult {
	remaining: Buffer;
	loaded?: LoadedSessionEntries;
}

function createReverseSessionScan(): ReverseSessionScan {
	return {
		activePath: [],
		hasInactiveEntries: false,
		isReadingLeaf: true,
		requiredParentId: null,
		latestCompaction: undefined,
		foundFirstKeptEntry: false,
		precedingCwd: undefined,
		allowIncompleteTrailingEntry: true,
	};
}

function parseReverseSessionEntry(scan: ReverseSessionScan, line: string, filePath: string): FileEntry | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (entry) {
		scan.allowIncompleteTrailingEntry = false;
		return entry;
	}
	if (scan.allowIncompleteTrailingEntry) {
		scan.allowIncompleteTrailingEntry = false;
		return undefined;
	}
	throw new Error(`Session file contains malformed JSONL entry: ${filePath}`);
}

function cwdFromChangedEntry(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "cwd_changed") return undefined;
	if (!entry.details || typeof entry.details !== "object" || !("cwd" in entry.details)) return undefined;
	return typeof entry.details.cwd === "string" ? entry.details.cwd : undefined;
}

function scanSessionEntryReverse(scan: ReverseSessionScan, entry: FileEntry): boolean {
	if (entry.type === "session") return false;

	const isActiveEntry = scan.isReadingLeaf || entry.id === scan.requiredParentId;
	if (!isActiveEntry) {
		scan.hasInactiveEntries = true;
		return false;
	}

	scan.isReadingLeaf = false;
	if (!scan.foundFirstKeptEntry) {
		scan.activePath.push(entry);
	}
	scan.requiredParentId = entry.parentId;
	if (!scan.latestCompaction && entry.type === "compaction") {
		scan.latestCompaction = entry;
	}
	if (!scan.foundFirstKeptEntry && scan.latestCompaction?.firstKeptEntryId === entry.id) {
		scan.foundFirstKeptEntry = true;
		return false;
	}
	if (!scan.foundFirstKeptEntry) return false;

	scan.precedingCwd = cwdFromChangedEntry(entry);
	return scan.precedingCwd !== undefined;
}

function loadedActiveSlice(scan: ReverseSessionScan): LoadedSessionEntries {
	return {
		entries: scan.activePath.slice().reverse(),
		precedingCwd: scan.precedingCwd,
		hasActiveSlice: scan.foundFirstKeptEntry,
	};
}

function scanCompleteReverseLines(scan: ReverseSessionScan, pending: Buffer, filePath: string): ReverseLineScanResult {
	let lineEnd = pending.length;
	let newlineIndex = pending.lastIndexOf(0x0a, lineEnd - 1);
	while (newlineIndex !== -1) {
		const line = pending.subarray(newlineIndex + 1, lineEnd).toString("utf8");
		const entry = parseReverseSessionEntry(scan, line, filePath);
		if (entry && scanSessionEntryReverse(scan, entry)) {
			return { remaining: Buffer.alloc(0), loaded: loadedActiveSlice(scan) };
		}
		lineEnd = newlineIndex;
		if (lineEnd === 0) break;
		newlineIndex = pending.lastIndexOf(0x0a, lineEnd - 1);
	}
	return { remaining: pending.subarray(0, lineEnd) };
}

function validateCompleteReverseScan(scan: ReverseSessionScan, filePath: string): void {
	const hasUnresolvedActiveParent = scan.activePath.length > 0 && scan.requiredParentId !== null;
	const missingParentPrecedesRetainedCompaction = scan.foundFirstKeptEntry;
	if (hasUnresolvedActiveParent && !missingParentPrecedesRetainedCompaction) {
		throw new Error(`Session file contains a broken active parent chain: ${filePath}`);
	}
	if (scan.latestCompaction && !scan.foundFirstKeptEntry) {
		throw new Error(
			`Session compaction ${scan.latestCompaction.id} references missing firstKeptEntryId ${scan.latestCompaction.firstKeptEntryId}: ${filePath}`,
		);
	}
}

export function readCurrentVersionSessionEntries(
	fd: number,
	fileSize: number,
	filePath: string,
): LoadedSessionEntries | undefined {
	const scan = createReverseSessionScan();
	let position = fileSize;
	let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	while (position > 0) {
		const bytesToRead = Math.min(SESSION_READ_BUFFER_SIZE, position);
		position -= bytesToRead;
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
		pending = Buffer.concat([buffer.subarray(0, bytesRead), pending]);

		const lineScan = scanCompleteReverseLines(scan, pending, filePath);
		if (lineScan.loaded) return lineScan.loaded;
		pending = lineScan.remaining;
	}

	const firstEntry = parseReverseSessionEntry(scan, pending.toString("utf8"), filePath);
	if (firstEntry && scanSessionEntryReverse(scan, firstEntry)) {
		return loadedActiveSlice(scan);
	}
	validateCompleteReverseScan(scan, filePath);
	return scan.foundFirstKeptEntry || !scan.hasInactiveEntries ? loadedActiveSlice(scan) : undefined;
}
