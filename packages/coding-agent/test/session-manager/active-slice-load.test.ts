import fs, { mkdtempSync, rmSync, writeFileSync } from "fs";
import { syncBuiltinESMExports } from "module";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

function messageEntry(id: string, parentId: string | null, content: string): object {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

describe("active slice session loading", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-active-slice-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not read the summarized prefix", () => {
		const file = join(tempDir, "large-compacted.jsonl");
		const summarizedBytes = 8 * 1024 * 1024;
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("old-1", null, "x".repeat(summarizedBytes)),
			{
				type: "custom_message",
				id: "cwd-change",
				parentId: "old-1",
				timestamp: "2025-01-01T00:00:00Z",
				customType: "cwd_changed",
				content: "Working directory changed to /tmp.",
				details: { previousCwd: "/previous", cwd: "/tmp" },
				display: true,
			},
			messageEntry("kept-1", "cwd-change", "kept"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-1", "after"),
		];
		const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(file, content);

		const originalReadSync = fs.readSync;
		let totalBytesRead = 0;
		fs.readSync = ((fd, buffer, offset, length, position) => {
			const bytesRead = originalReadSync(fd, buffer, offset, length, position);
			totalBytesRead += bytesRead;
			return bytesRead;
		}) as typeof fs.readSync;
		syncBuiltinESMExports();

		try {
			SessionManager.open(file, tempDir);
		} finally {
			fs.readSync = originalReadSync;
			syncBuiltinESMExports();
		}

		expect(totalBytesRead).toBeLessThan(Buffer.byteLength(content) / 2);
	});

	it("ignores one incomplete trailing entry", () => {
		const file = join(tempDir, "truncated-tail.jsonl");
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			}),
			JSON.stringify(messageEntry("old-1", null, "old")),
			JSON.stringify(messageEntry("kept-1", "old-1", "kept")),
			JSON.stringify({
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			}),
			JSON.stringify(messageEntry("after-1", "compaction-1", "after")),
		];
		writeFileSync(file, `${lines.join("\n")}\n{"type":"message"`);

		const session = SessionManager.open(file, tempDir);

		expect(session.getEntries().map((entry) => entry.id)).toEqual(["kept-1", "compaction-1", "after-1"]);
	});

	it("rejects malformed interior entries", () => {
		const file = join(tempDir, "malformed-compacted.jsonl");
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			}),
			JSON.stringify(messageEntry("old-1", null, "old")),
			JSON.stringify(messageEntry("kept-1", "old-1", "kept")),
			"not json",
			JSON.stringify({
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			}),
			JSON.stringify(messageEntry("after-1", "compaction-1", "after")),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);

		expect(() => SessionManager.open(file, tempDir)).toThrow(/malformed JSONL entry/);
	});

	it("rejects a broken active parent chain", () => {
		const file = join(tempDir, "broken-parent.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("leaf", "missing-parent", "orphan"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		expect(() => SessionManager.open(file, tempDir)).toThrow(/broken active parent chain/);
	});

	it("rejects a compaction with a missing first kept entry", () => {
		const file = join(tempDir, "missing-first-kept.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("old-1", null, "old"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "old-1",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "missing-entry",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-1", "after"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		expect(() => SessionManager.open(file, tempDir)).toThrow(/missing firstKeptEntryId/);
	});

	it("restores cwd from the summarized prefix without retaining its entry", () => {
		const file = join(tempDir, "compacted-cwd.jsonl");
		const initialCwd = join(tempDir, "initial");
		const relocatedCwd = join(tempDir, "relocated");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: initialCwd,
			},
			messageEntry("old-1", null, "old"),
			{
				type: "custom_message",
				id: "cwd-change",
				parentId: "old-1",
				timestamp: "2025-01-01T00:00:00Z",
				customType: "cwd_changed",
				content: `Working directory changed to ${relocatedCwd}.`,
				details: { previousCwd: initialCwd, cwd: relocatedCwd },
				display: true,
			},
			messageEntry("kept-1", "cwd-change", "kept"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-1", "after"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(file, tempDir);

		expect(session.getCwd()).toBe(relocatedCwd);
		expect(session.getEntries().map((entry) => entry.id)).toEqual(["kept-1", "compaction-1", "after-1"]);
	});

	it("forks only the active compacted slice", () => {
		const file = join(tempDir, "fork-source.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: tempDir,
			},
			messageEntry("old-1", null, "summarized"),
			messageEntry("kept-1", "old-1", "kept"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-1", "after"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const forked = SessionManager.forkFrom(file, tempDir, join(tempDir, "forks"), { id: "forked" });
		const forkedFile = forked.getSessionFile();
		expect(forkedFile).toBeDefined();
		const serializedIds = fs
			.readFileSync(forkedFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string; type: string })
			.filter((entry) => entry.type !== "session")
			.map((entry) => entry.id);
		expect(serializedIds).toEqual(["kept-1", "compaction-1", "after-1"]);
	});

	it("retains only the active compacted slice", () => {
		const file = join(tempDir, "compacted.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("old-1", null, "old 1"),
			messageEntry("old-2", "old-1", "old 2"),
			messageEntry("kept-1", "old-2", "kept 1"),
			messageEntry("kept-2", "kept-1", "kept 2"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-2",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-1", "after 1"),
			messageEntry("after-2", "after-1", "after 2"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(file, tempDir);

		expect(session.getEntries().map((entry) => entry.id)).toEqual([
			"kept-1",
			"kept-2",
			"compaction-1",
			"after-1",
			"after-2",
		]);
	});
});
