import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FileEntry, migrateSessionEntries, SessionManager } from "../../src/core/session-manager.ts";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set (v3 is current after hookMessage->custom migration)
		expect(entries[0]).toMatchObject({ version: 3 });

		// Entries should have id/parentId
		const msg1 = entries[1] as { id?: string; parentId?: string | null };
		const msg2 = entries[2] as { id?: string; parentId?: string | null };

		expect(msg1.id).toBeDefined();
		expect(msg1.id?.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id?.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect(entries[1]).toMatchObject({ id: "abc12345" });
		expect(entries[2]).toMatchObject({ id: "def67890", parentId: "abc12345" });
	});
});

describe("SessionManager.forkFrom with a legacy source", () => {
	it("migrates v1 entries so every message stays in the fork", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-legacy-fork-"));
		try {
			const sourcePath = join(dir, "source.jsonl");
			const lines = [
				{ type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00Z", cwd: dir },
				{
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "first", timestamp: 1 },
				},
				{
					type: "message",
					timestamp: "2025-01-01T00:00:02Z",
					message: { role: "user", content: "second", timestamp: 2 },
				},
			];
			writeFileSync(sourcePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

			const forked = SessionManager.forkFrom(sourcePath, dir, dir);

			const contents = forked
				.buildSessionContext()
				.messages.map((message) => "content" in message && message.content);
			expect(contents).toEqual(["first", "second"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
