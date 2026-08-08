import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager.updateCompactionSummary", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-update-compaction-summary-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("persists an edited summary without changing compaction identity or context state", () => {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd);
		const session = SessionManager.create(cwd, tempDir);

		session.appendMessage(userMsg("old question"));
		session.appendMessage(assistantMsg("old answer"));
		const firstKeptEntryId = session.appendMessage(userMsg("kept question"));
		session.appendMessage(assistantMsg("kept answer"));
		const compactionId = session.appendCompaction(
			"original summary",
			firstKeptEntryId,
			42_000,
			{ source: "test" },
			true,
			321,
			{
				provider: "openai",
				api: "openai-responses",
				format: "openai.responses.input",
				value: [{ type: "compaction", encrypted_content: "encrypted" }],
			},
		);
		session.appendMessage(userMsg("new question"));
		session.appendMessage(assistantMsg("new answer"));

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const leafId = session.getLeafId();
		const compaction = session.getEntry(compactionId);
		if (!compaction || compaction.type !== "compaction") {
			throw new Error("Expected compaction entry");
		}
		const originalCompaction = structuredClone(compaction);

		session.updateCompactionSummary(compactionId, "edited summary");

		const reopened = SessionManager.open(sessionFile, tempDir);
		const editedCompaction = reopened.getEntry(compactionId);
		if (!editedCompaction || editedCompaction.type !== "compaction") {
			throw new Error("Expected edited compaction entry");
		}
		expect(editedCompaction).toEqual({
			...originalCompaction,
			summary: "edited summary",
		});
		expect(reopened.getLeafId()).toBe(leafId);

		const contextCompaction = reopened.buildContextEntries().find((entry) => entry.type === "compaction");
		if (!contextCompaction || contextCompaction.type !== "compaction") {
			throw new Error("Expected compaction in context entries");
		}
		expect(contextCompaction.summary).toBe("edited summary");

		const context = reopened.buildSessionContext();
		expect(context.messages[0]).toMatchObject({ role: "compactionSummary", summary: "edited summary" });
	});

	it("keeps the in-memory summary unchanged when persistence fails", () => {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd);
		const session = SessionManager.create(cwd, tempDir);
		const firstKeptEntryId = session.appendMessage(userMsg("kept question"));
		session.appendMessage(assistantMsg("kept answer"));
		const compactionId = session.appendCompaction("original summary", firstKeptEntryId, 42_000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		rmSync(sessionFile);
		mkdirSync(sessionFile);

		expect(() => session.updateCompactionSummary(compactionId, "edited summary")).toThrow();

		const compaction = session.getEntry(compactionId);
		if (!compaction || compaction.type !== "compaction") {
			throw new Error("Expected compaction entry");
		}
		expect(compaction.summary).toBe("original summary");
	});
});
