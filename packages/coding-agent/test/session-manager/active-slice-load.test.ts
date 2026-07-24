import { mkdtempSync, rmSync, writeFileSync } from "fs";
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
