import { spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { syncBuiltinESMExports } from "module";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir, SessionManager, type SessionTreeNode } from "../../src/core/session-manager.ts";

function messageEntry(id: string, parentId: string | null, content: string): object {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function treeEntryIds(nodes: SessionTreeNode[]): string[] {
	return nodes.flatMap((node) => [node.entry.id, ...treeEntryIds(node.children)]);
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

	it("loads the active slice when a reverse-read chunk begins at a newline", () => {
		const file = join(tempDir, "newline-boundary.jsonl");
		const header = {
			type: "session" as const,
			version: 3,
			id: "session-1",
			timestamp: "2025-01-01T00:00:00Z",
			cwd: "/tmp",
		};
		const oldEntry = messageEntry("old-1", null, "old");
		const keptEntry = messageEntry("kept-1", "old-1", "kept");
		const compactionEntry = {
			type: "compaction" as const,
			id: "compaction-1",
			parentId: "kept-1",
			timestamp: "2025-01-01T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept-1",
			tokensBefore: 1000,
		};
		const bufferSize = 1024 * 1024;
		const compactionLine = JSON.stringify(compactionEntry);
		const emptyAfterLine = JSON.stringify(messageEntry("after-1", "compaction-1", ""));
		const afterContentBytes =
			bufferSize - 1 - Buffer.byteLength(compactionLine) - 1 - Buffer.byteLength(emptyAfterLine) - 1;
		const afterEntry = messageEntry("after-1", "compaction-1", "x".repeat(afterContentBytes));
		const suffix = `\n${compactionLine}\n${JSON.stringify(afterEntry)}\n`;
		expect(Buffer.byteLength(suffix)).toBe(bufferSize);

		const prefix = [header, oldEntry, keptEntry].map((entry) => JSON.stringify(entry)).join("\n");
		const content = prefix + suffix;
		expect(Buffer.byteLength(content) - bufferSize).toBe(Buffer.byteLength(prefix));
		expect(Buffer.from(content)[Buffer.byteLength(prefix)]).toBe(0x0a);
		writeFileSync(file, content);

		const fixture = resolve(__dirname, "open-session-fixture.ts");
		const tsxLoader = resolve(__dirname, "../../../../node_modules/tsx/dist/loader.mjs");
		const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--import", tsxLoader, fixture, file], {
			encoding: "utf8",
			timeout: 5_000,
			env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json") },
		});

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(["kept-1", "compaction-1", "after-1"]);
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

	it("opens a compacted active slice whose summarized prefix was omitted", () => {
		const file = join(tempDir, "relocated-active-slice.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("kept-1", "missing-summarized-parent", "kept"),
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

		expect(session.getEntries().map((entry) => entry.id)).toEqual(["kept-1", "compaction-1", "after-1"]);
	});

	it("preserves the complete JSONL when relocating an opened compacted slice", () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const agentDir = join(tempDir, "agent");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const sourceSessionDir = getDefaultSessionDir(projectA, agentDir);
		const sourceFile = join(sourceSessionDir, "compacted.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-08-04T00:00:00.000Z",
				cwd: projectA,
			},
			messageEntry("old-1", null, "summarized"),
			messageEntry("kept-1", "old-1", "kept"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2026-08-04T00:00:03.000Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-1", "after"),
		];
		const originalContent = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(sourceFile, originalContent);

		const session = SessionManager.open(sourceFile, sourceSessionDir);
		expect(session.getEntries().map((entry) => entry.id)).toEqual(["kept-1", "compaction-1", "after-1"]);

		session.relocate(projectB, agentDir);

		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected relocated session file");
		expect(movedFile).toBe(join(getDefaultSessionDir(projectB, agentDir), basename(sourceFile)));
		expect(readFileSync(movedFile, "utf8")).toBe(originalContent);
		expect(
			SessionManager.open(movedFile)
				.getEntries()
				.map((entry) => entry.id),
		).toEqual(["kept-1", "compaction-1", "after-1"]);
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

	it("uses the latest compaction on the active branch", () => {
		const file = join(tempDir, "multiple-compactions.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("old-1", null, "old"),
			messageEntry("first-kept", "old-1", "first kept"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "first-kept",
				timestamp: "2025-01-01T00:00:00Z",
				summary: "first summary",
				firstKeptEntryId: "first-kept",
				tokensBefore: 500,
			},
			messageEntry("between", "compaction-1", "between"),
			messageEntry("latest-kept", "between", "latest kept"),
			{
				type: "compaction",
				id: "compaction-2",
				parentId: "latest-kept",
				timestamp: "2025-01-01T00:01:00Z",
				summary: "latest summary",
				firstKeptEntryId: "latest-kept",
				tokensBefore: 1000,
			},
			messageEntry("after-1", "compaction-2", "after"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(file, tempDir);

		expect(session.getEntries().map((entry) => entry.id)).toEqual(["latest-kept", "compaction-2", "after-1"]);
	});

	it("clears label state omitted before the retained slice", () => {
		const labeledFile = join(tempDir, "labeled.jsonl");
		const labeledEntries = [
			{
				type: "session",
				version: 3,
				id: "labeled-session",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			messageEntry("target", null, "target"),
			{
				type: "label",
				id: "label-1",
				parentId: "target",
				timestamp: "2025-01-01T00:00:00Z",
				targetId: "target",
				label: "stale",
			},
		];
		writeFileSync(labeledFile, `${labeledEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const session = SessionManager.open(labeledFile, tempDir);
		expect(session.getLabel("target")).toBe("stale");

		const compactedFile = join(tempDir, "compacted-label.jsonl");
		const compactedEntries = [
			{
				type: "session",
				version: 3,
				id: "compacted-session",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			...labeledEntries.slice(1),
			messageEntry("kept-1", "label-1", "kept"),
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
		writeFileSync(compactedFile, `${compactedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		session.setSessionFile(compactedFile);

		expect(session.getLabel("target")).toBeUndefined();
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

		const activeIds = ["kept-1", "kept-2", "compaction-1", "after-1", "after-2"];
		expect(session.getEntries().map((entry) => entry.id)).toEqual(activeIds);
		expect(session.getBranch().map((entry) => entry.id)).toEqual(activeIds);
		expect(treeEntryIds(session.getTree())).toEqual(activeIds);
	});
});
