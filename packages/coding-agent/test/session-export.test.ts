import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessionToJsonl } from "../src/core/session-export.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string): object {
	const content = role === "user" ? text : [{ type: "text", text }];
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role, content, timestamp: 1 },
	};
}

describe("exportSessionToJsonl", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-export-"));
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("exports the whole current branch of a reopened compacted session, not only its loaded slice", () => {
		const file = join(tempDir, "compacted.jsonl");
		const entries = [
			{ type: "session", version: 3, id: "session-1", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir },
			message("old-user", null, "user", "Original request"),
			message("old-assistant", "old-user", "assistant", "Original reply"),
			message("kept-1", "old-assistant", "user", "kept"),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "kept-1",
				timestamp: "2025-01-01T00:00:01Z",
				summary: "summary",
				firstKeptEntryId: "kept-1",
				tokensBefore: 1000,
			},
			message("after-1", "compaction-1", "user", "after"),
		];
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const session = SessionManager.open(file, tempDir);

		const output = exportSessionToJsonl(session, join(tempDir, "out.jsonl"));

		const exported = readFileSync(output, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: string; parentId?: string | null });
		expect(exported.slice(1).map((entry) => [entry.id, entry.parentId])).toEqual([
			["old-user", null],
			["old-assistant", "old-user"],
			["kept-1", "old-assistant"],
			["compaction-1", "kept-1"],
			["after-1", "compaction-1"],
		]);
	});
});
