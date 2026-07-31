import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES,
	migrateToolResultSessionFiles,
	TOOL_RESULT_TRUNCATION_MARKER,
	truncateToolResultForPersistence,
} from "../src/core/session-tool-output.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-tool-output-"));
	tempDirs.push(dir);
	return dir;
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function textFromToolResult(message: ToolResultMessage): string {
	const text = message.content.find((item) => item.type === "text");
	if (!text || text.type !== "text") throw new Error("expected text tool result");
	return text.text;
}

function writeSession(path: string, message: ToolResultMessage): void {
	writeFileSync(
		path,
		`${[
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: fauxAssistantMessage("assistant"),
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date().toISOString(),
				message,
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

describe("persisted tool result output", () => {
	it("caps a single-line tool result on disk without changing the runtime entry", () => {
		const dir = createTempDir();
		const session = SessionManager.create(dir, dir, { id: "session-1" });
		const original = "x".repeat(MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES + 100);
		session.appendMessage(fauxAssistantMessage("assistant"));
		const entryId = session.appendMessage(toolResult(original));

		const persistedLines = readFileSync(session.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const persisted = persistedLines.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		const persistedText = textFromToolResult(persisted.message);
		const runtimeEntry = session.getEntry(entryId);
		if (!runtimeEntry || runtimeEntry.type !== "message") throw new Error("expected persisted message entry");

		expect(Buffer.byteLength(persistedText, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES);
		expect(persistedText).toContain(TOOL_RESULT_TRUNCATION_MARKER);
		expect(textFromToolResult(runtimeEntry.message as ToolResultMessage)).toBe(original);
	});

	it("truncates multibyte UTF-8 at a valid boundary and preserves the marker", () => {
		const entry = {
			type: "message" as const,
			id: "tool-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: toolResult("😀漢字".repeat(MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES)),
		};

		const persisted = truncateToolResultForPersistence(entry);
		const text = textFromToolResult(persisted.message as ToolResultMessage);

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES);
		expect(text).toContain(TOOL_RESULT_TRUNCATION_MARKER);
		expect(text).not.toContain("�");
	});

	it("returns unchanged small tool results", () => {
		const entry = {
			type: "message" as const,
			id: "tool-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: toolResult("small output"),
		};

		expect(truncateToolResultForPersistence(entry)).toBe(entry);
	});
});

describe("tool result session migration", () => {
	it("rewrites oversized sessions atomically with backups and is idempotent", () => {
		const agentDir = createTempDir();
		const sessionDir = join(agentDir, "sessions", "project");
		const sessionPath = join(sessionDir, "session.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		const malformedPath = join(agentDir, "broken.jsonl");
		const nonSessionPath = join(agentDir, "other.jsonl");
		writeSession(sessionPath, toolResult("y".repeat(MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES + 1)));
		writeFileSync(malformedPath, "not json\n");
		writeFileSync(nonSessionPath, '{"type":"event"}\n');

		const first = migrateToolResultSessionFiles(agentDir);
		const backups = readdirSync(sessionDir).filter((name) => name.includes(".tool-output-backup-"));
		const migrated = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[2]);

		expect(first.changedFiles).toBe(1);
		expect(first.truncatedMessages).toBe(1);
		expect(first.skippedMalformedFiles).toBe(1);
		expect(first.skippedNonSessionFiles).toBe(1);
		expect(backups).toHaveLength(1);
		expect(Buffer.byteLength(textFromToolResult(migrated.message), "utf8")).toBeLessThanOrEqual(
			MAX_PERSISTED_TOOL_RESULT_CONTENT_BYTES,
		);

		const second = migrateToolResultSessionFiles(agentDir);
		expect(second.changedFiles).toBe(0);
		expect(second.truncatedMessages).toBe(0);
		expect(readdirSync(sessionDir).filter((name) => name.includes(".tool-output-backup-")).length).toBe(1);
		expect(existsSync(sessionPath)).toBe(true);
	});
});
