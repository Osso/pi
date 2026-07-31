import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { FileEntry, SessionEntry, SessionMessageEntry } from "./session-manager.ts";

export const MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES = 1_048_576;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[tool output truncated at 1 MiB]";

export interface ToolResultSessionMigrationReport {
	scannedFiles: number;
	changedFiles: number;
	truncatedMessages: number;
	skippedMalformedFiles: number;
	skippedNonSessionFiles: number;
	skippedErrorFiles: number;
	backupPaths: string[];
	errors: string[];
}

interface TextContentLike {
	type: "text";
	text: string;
}

interface ToolResultMessageLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: unknown[];
	isError: boolean;
	timestamp: number;
	details?: unknown;
}

function isTextContent(value: unknown): value is TextContentLike {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

function isToolResultMessage(message: AgentMessage): message is AgentMessage & ToolResultMessageLike {
	return message.role === "toolResult" && Array.isArray(message.content);
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;

	let end = maxBytes;
	while (end > 0) {
		const bytes = buffer.subarray(0, end);
		const prefix = bytes.toString("utf8");
		if (Buffer.from(prefix, "utf8").equals(bytes)) return prefix;
		end -= 1;
	}
	return "";
}

function textContentBytes(content: unknown[]): number {
	return content.reduce<number>((total, item) => (isTextContent(item) ? total + utf8Bytes(item.text) : total), 0);
}

function capTextContent(content: unknown[]): unknown[] {
	const totalBytes = textContentBytes(content);
	if (totalBytes <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) return content;

	let remainingBytes = MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES - utf8Bytes(TOOL_RESULT_TRUNCATION_MARKER);
	return content.map((item) => {
		if (!isTextContent(item)) return item;
		if (remainingBytes <= 0) return { ...item, text: "" } satisfies TextContent;

		const itemBytes = utf8Bytes(item.text);
		if (itemBytes <= remainingBytes) {
			remainingBytes -= itemBytes;
			return item;
		}

		const prefix = utf8Prefix(item.text, remainingBytes);
		remainingBytes = 0;
		return { ...item, text: `${prefix}${TOOL_RESULT_TRUNCATION_MARKER}` } satisfies TextContent;
	});
}

function serializedContentBytes(content: unknown[]): number {
	return utf8Bytes(JSON.stringify(content));
}

function capSerializedContent(content: unknown[]): unknown[] {
	if (serializedContentBytes(content) <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) return content;

	const text = content
		.filter(isTextContent)
		.map((item) => item.text)
		.join("\n");
	const marker = TOOL_RESULT_TRUNCATION_MARKER;
	let low = 0;
	let high = utf8Bytes(text);
	let best = marker;

	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = `${utf8Prefix(text, middle)}${marker}`;
		if (serializedContentBytes([{ type: "text", text: candidate }]) <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return [{ type: "text", text: best }];
}

function capToolResultContent(content: unknown[]): unknown[] {
	return capSerializedContent(capTextContent(content));
}

function serializedEntryBytes(entry: SessionMessageEntry): number {
	return utf8Bytes(JSON.stringify(entry));
}

function withoutToolResultDetails(message: ToolResultMessageLike): ToolResultMessageLike {
	const { details: _details, ...messageWithoutDetails } = message as ToolResultMessageLike & { details?: unknown };
	return messageWithoutDetails;
}

function buildToolResultCandidate(
	entry: SessionMessageEntry,
	message: ToolResultMessageLike,
	content: unknown[],
): SessionMessageEntry {
	return { ...entry, message: { ...message, content } } as SessionMessageEntry;
}

function capToolResultEntry(entry: SessionMessageEntry, message: ToolResultMessageLike): SessionMessageEntry {
	if (serializedEntryBytes(entry) <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) return entry;
	const initialContent = capToolResultContent(message.content);
	const initialEntry = buildToolResultCandidate(entry, message, initialContent);
	if (serializedEntryBytes(initialEntry) <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) return initialEntry;

	const text = message.content.filter(isTextContent).map((item) => item.text).join("\n");
	const nonTextContent = message.content.filter((item) => !isTextContent(item));
	const marker = TOOL_RESULT_TRUNCATION_MARKER;
	const messageVariants = [message, withoutToolResultDetails(message)];
	for (const messageVariant of messageVariants) {
		let low = 0;
		let high = utf8Bytes(text);
		let best = buildToolResultCandidate(entry, messageVariant, [...nonTextContent, { type: "text", text: marker }]);
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candidate = buildToolResultCandidate(entry, messageVariant, [
				...nonTextContent,
				{ type: "text", text: `${utf8Prefix(text, middle)}${marker}` },
			]);
			if (serializedEntryBytes(candidate) <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) {
				best = candidate;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		if (serializedEntryBytes(best) <= MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES) return best;
	}

	const minimalMessage = {
		role: "toolResult" as const,
		toolCallId: utf8Prefix(message.toolCallId, 128),
		toolName: utf8Prefix(message.toolName, 128),
		content: [{ type: "text", text: marker }],
		isError: message.isError,
		timestamp: message.timestamp,
	};
	return buildToolResultCandidate(entry, minimalMessage, minimalMessage.content);
}

/** Return a persistence-only copy of a session message entry with capped tool output. */
export function truncateToolResultForPersistence<T extends SessionMessageEntry>(entry: T): T {
	if (!isToolResultMessage(entry.message)) return entry;
	const capped = capToolResultEntry(entry, entry.message);
	return capped === entry ? entry : (capped as T);
}

/** Serialize one session entry while applying persistence-only tool-result truncation. */
export function serializeSessionEntryForPersistence(entry: FileEntry | SessionEntry): string {
	const persistedEntry = entry.type === "message" ? truncateToolResultForPersistence(entry) : entry;
	return JSON.stringify(persistedEntry);
}

function listJsonlFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) continue;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files;
}

function createMigrationReport(): ToolResultSessionMigrationReport {
	return {
		scannedFiles: 0,
		changedFiles: 0,
		truncatedMessages: 0,
		skippedMalformedFiles: 0,
		skippedNonSessionFiles: 0,
		skippedErrorFiles: 0,
		backupPaths: [],
		errors: [],
	};
}

function backupPathFor(filePath: string, now: Date): string {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return `${filePath}.tool-output-backup-${timestamp}-${randomUUID().slice(0, 8)}`;
}

interface ParsedSessionFile {
	kind: "session";
	lines: string[];
	entries: FileEntry[];
	size: number;
	mtimeMs: number;
	mode: number;
}

type SessionFileParseResult = ParsedSessionFile | { kind: "malformed" } | { kind: "non-session" };

function readSessionFileForMigration(filePath: string): SessionFileParseResult {
	const fileStat = statSync(filePath);
	const lines = readFileSync(filePath, "utf8").split("\n");
	const entries: FileEntry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as FileEntry);
		} catch {
			return { kind: "malformed" };
		}
	}

	const header = entries[0];
	if (!header || header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return { kind: "non-session" };
	}
	return { kind: "session", lines, entries, size: fileStat.size, mtimeMs: fileStat.mtimeMs, mode: fileStat.mode & 0o777 };
}

function buildRewrittenSessionContent(
	filePath: string,
	lines: string[],
	entries: FileEntry[],
	changedIndexes: Set<number>,
): string {
	const rewrittenLines: string[] = [];
	let entryIndex = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (!line?.trim()) {
			rewrittenLines.push(line ?? "");
			continue;
		}
		const entry = entries[entryIndex];
		if (!entry) throw new Error(`Missing parsed entry for ${filePath}:${lineIndex + 1}`);
		rewrittenLines.push(changedIndexes.has(entryIndex) ? serializeSessionEntryForPersistence(entry) : line);
		entryIndex += 1;
	}
	return rewrittenLines.join("\n");
}

function writeSessionFileAtomically(filePath: string, content: string, parsed: ParsedSessionFile, now: Date): string {
	const currentStat = statSync(filePath);
	if (currentStat.size !== parsed.size || currentStat.mtimeMs !== parsed.mtimeMs) {
		throw new Error("session changed while scanning; rerun after it is idle");
	}

	const backupPath = backupPathFor(filePath, now);
	const tempPath = `${filePath}.tool-output-temp-${randomUUID()}`;
	copyFileSync(filePath, backupPath);
	try {
		writeFileSync(tempPath, content, { flag: "wx", mode: parsed.mode });
		chmodSync(tempPath, parsed.mode);
		renameSync(tempPath, filePath);
	} finally {
		rmSync(tempPath, { force: true });
	}
	return backupPath;
}

function rewriteSessionFile(
	filePath: string,
	parsed: ParsedSessionFile,
	changedIndexes: Set<number>,
	now: Date,
): string {
	const content = buildRewrittenSessionContent(filePath, parsed.lines, parsed.entries, changedIndexes);
	return writeSessionFileAtomically(filePath, content, parsed, now);
}

/** Scan and atomically rewrite oversized tool-result content under an agent directory. */
export function migrateToolResultSessionFiles(
	agentDir: string,
	now: () => Date = () => new Date(),
): ToolResultSessionMigrationReport {
	const report = createMigrationReport();
	for (const filePath of listJsonlFiles(agentDir)) {
		report.scannedFiles += 1;
		try {
			const parsed = readSessionFileForMigration(filePath);
			if (parsed.kind === "malformed") {
				report.skippedMalformedFiles += 1;
				report.errors.push(`${filePath}: malformed JSONL`);
				continue;
			}
			if (parsed.kind === "non-session") {
				report.skippedNonSessionFiles += 1;
				continue;
			}

			const cappedEntries = parsed.entries.map((entry) =>
				entry.type === "message" ? truncateToolResultForPersistence(entry) : entry,
			);
			const changedIndexes = new Set(
				cappedEntries.flatMap((entry, index) => (entry !== parsed.entries[index] ? [index] : [])),
			);
			if (changedIndexes.size === 0) continue;

			const backupPath = rewriteSessionFile(filePath, { ...parsed, entries: cappedEntries }, changedIndexes, now());
			report.changedFiles += 1;
			report.truncatedMessages += changedIndexes.size;
			report.backupPaths.push(backupPath);
		} catch (error) {
			report.skippedErrorFiles += 1;
			report.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return report;
}
