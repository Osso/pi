import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getControlDbPath, writeSessionMetadata } from "../../src/core/session-control-db.ts";
import { buildSessionInfo, type FileEntry, SessionManager } from "../../src/core/session-manager.ts";

function assistantMessage(timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Reply" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function writeCompactedSession(file: string, cwd: string, extensionOnly: boolean): void {
	const timestamp = "1970-01-01T00:00:00.000Z";
	const messageEntry = (id: string, parentId: string | null, text: string, time: number): FileEntry => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content: text,
			timestamp: time,
			...(extensionOnly ? { inputSource: "extension" as const } : {}),
		},
	});
	const replyEntry = (id: string, parentId: string, time: number): FileEntry => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: assistantMessage(time),
	});
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id: "slice-metadata", timestamp, cwd },
		messageEntry("old-user", null, "Original request", 1000),
		replyEntry("old-assistant", "old-user", 9000),
		messageEntry("inactive-user", "old-assistant", "Inactive request", 2000),
		replyEntry("inactive-assistant", "inactive-user", 3000),
		{ type: "label", id: "old-label", parentId: "old-assistant", timestamp, targetId: "old-user", label: "Old" },
		messageEntry("kept-user", "old-label", "Retained request", 4000),
		replyEntry("kept-assistant", "kept-user", 5000),
		{
			type: "compaction",
			id: "compaction",
			parentId: "kept-assistant",
			timestamp,
			summary: "Earlier conversation",
			firstKeptEntryId: "kept-user",
			tokensBefore: 100,
		},
		messageEntry("after-user", "compaction", "After compaction", 6000),
		replyEntry("after-assistant", "after-user", 7000),
	];
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("active-slice session metadata", () => {
	let dir: string;
	let file: string;
	let controlDbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "active-slice-metadata-"));
		file = join(dir, "session.jsonl");
		controlDbPath = getControlDbPath(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		{ seed: true, extensionOnly: false },
		{ seed: false, extensionOnly: false },
		{ seed: true, extensionOnly: true },
	])("preserves whole-file metadata on reopen and append ($seed, $extensionOnly)", async ({ seed, extensionOnly }) => {
		writeCompactedSession(file, dir, extensionOnly);
		const info = await buildSessionInfo(file);
		if (!info) throw new Error("Expected session info");
		const firstMessage = extensionOnly ? "(no messages)" : "Original request";
		expect(info).toMatchObject({ messageCount: 8, firstMessage, modified: new Date(9000) });
		if (seed) {
			writeSessionMetadata(controlDbPath, {
				sessionPath: file,
				id: info.id,
				cwd: dir,
				createdAt: info.created.toISOString(),
				modifiedAt: info.modified.toISOString(),
				messageCount: info.messageCount,
				firstMessage: info.firstMessage,
			});
		}

		const reopened = SessionManager.open(file);
		reopened.setMetadataControlDbPath(controlDbPath);
		expect(await SessionManager.list(dir, dir, undefined, controlDbPath)).toMatchObject([
			{ messageCount: 8, firstMessage, modified: new Date(9000) },
		]);

		reopened.appendMessage({ role: "user", content: "New request", timestamp: 8000 });
		expect(await SessionManager.list(dir, dir, undefined, controlDbPath)).toMatchObject([
			{ messageCount: 9, firstMessage: extensionOnly ? "New request" : firstMessage, modified: new Date(9000) },
		]);
		reopened.appendMessage(assistantMessage(10000));
		expect(await SessionManager.list(dir, dir, undefined, controlDbPath)).toMatchObject([
			{ messageCount: 10, firstMessage: extensionOnly ? "New request" : firstMessage, modified: new Date(10000) },
		]);
	});

	it("counts a message whose text contains U+2028 as one entry", async () => {
		const timestamp = "1970-01-01T00:00:00.000Z";
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "separator", timestamp, cwd: dir },
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Fix the parser\u2028and the lexer", timestamp: 1000 },
			},
			{ type: "message", id: "assistant", parentId: "user", timestamp, message: assistantMessage(2000) },
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		expect(await buildSessionInfo(file)).toMatchObject({
			id: "separator",
			messageCount: 2,
			firstMessage: expect.stringContaining("Fix the parser"),
			modified: new Date(2000),
		});
	});

	it("uses the authoritative indexed values rather than rebuilding an active slice's metadata", async () => {
		writeCompactedSession(file, dir, false);
		writeSessionMetadata(controlDbPath, {
			sessionPath: file,
			id: "slice-metadata",
			cwd: dir,
			createdAt: new Date(0).toISOString(),
			modifiedAt: new Date(12000).toISOString(),
			messageCount: 18,
			firstMessage: "Indexed request",
		});
		const reopened = SessionManager.open(file);
		reopened.setMetadataControlDbPath(controlDbPath);
		reopened.setSessionFile(file);
		reopened.appendMessage({ role: "user", content: "New request", timestamp: 8000 });
		reopened.appendMessage(assistantMessage(10000));
		expect(await SessionManager.list(dir, dir, undefined, controlDbPath)).toMatchObject([
			{ messageCount: 20, firstMessage: "Indexed request", modified: new Date(12000) },
		]);

		reopened.branch("old-user");
		reopened.appendMessage({ role: "user", content: "Branched request", timestamp: 11000 });
		expect(await SessionManager.list(dir, dir, undefined, controlDbPath)).toMatchObject([
			{ messageCount: 11, firstMessage: "Original request", modified: new Date(11000) },
		]);
	});
});
