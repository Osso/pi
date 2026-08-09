import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import { convertToLlm } from "../../src/core/messages.ts";
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

	it("replaces provider-native compaction context with the edited plaintext summary", () => {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd);
		const session = SessionManager.create(cwd, tempDir);
		const firstKeptEntryId = session.appendMessage(userMsg("kept question"));
		session.appendMessage(assistantMsg("kept answer"));
		const providerNative = {
			provider: "openai",
			api: "openai-responses",
			format: "openai.responses.input" as const,
			value: [{ type: "compaction_summary", encrypted_content: "encrypted-native-checkpoint" }],
		};
		const details = {
			type: "openai-remote-compaction",
			version: 1,
			provider: "openai",
			api: "openai-responses",
			model: "gpt-test",
			endpoint: "https://api.openai.test/v1/responses/compact",
			replacementHistory: providerNative.value,
			replacementHistoryBytes: 128,
			replacementHistoryTokens: 32,
		};
		const compactionId = session.appendCompaction(
			"OpenAI native compaction stored in session entry details.",
			firstKeptEntryId,
			42_000,
			details,
			true,
			321,
			providerNative,
		);
		const leafId = session.getLeafId();
		const original = session.getEntry(compactionId);
		if (!original || original.type !== "compaction") throw new Error("Expected compaction entry");

		session.updateCompactionSummary(compactionId, "edited plaintext summary");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reopened = SessionManager.open(sessionFile, tempDir);
		const edited = reopened.getEntry(compactionId);
		if (!edited || edited.type !== "compaction") throw new Error("Expected edited compaction entry");
		expect(edited).toEqual({
			...original,
			summary: "edited plaintext summary",
			details: undefined,
			providerNative: undefined,
		});
		expect(reopened.getLeafId()).toBe(leafId);
		const sessionMessages = reopened.buildSessionContext().messages;
		expect(sessionMessages[0]).toMatchObject({
			role: "compactionSummary",
			summary: "edited plaintext summary",
			providerNative: undefined,
		});
		const serialized = convertResponsesMessages(
			{
				id: "gpt-test",
				name: "GPT Test",
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4_096,
			},
			{ messages: convertToLlm(sessionMessages) },
			new Set(["openai"]),
			{ includeSystemPrompt: false },
		);
		expect(JSON.stringify(serialized)).toContain("edited plaintext summary");
		expect(JSON.stringify(serialized)).not.toContain("encrypted-native-checkpoint");
	});

	it("restores provider-native fields when persistence fails", () => {
		const cwd = join(tempDir, "project");
		mkdirSync(cwd);
		const session = SessionManager.create(cwd, tempDir);
		const firstKeptEntryId = session.appendMessage(userMsg("kept question"));
		session.appendMessage(assistantMsg("kept answer"));
		const compactionId = session.appendCompaction(
			"original summary",
			firstKeptEntryId,
			42_000,
			{ type: "openai-remote-compaction", replacementHistory: [] },
			true,
			321,
			{
				provider: "openai",
				api: "openai-responses",
				format: "openai.responses.input",
				value: [{ type: "compaction_summary", encrypted_content: "encrypted-native-checkpoint" }],
			},
		);
		const original = structuredClone(session.getEntry(compactionId));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		rmSync(sessionFile);
		mkdirSync(sessionFile);

		expect(() => session.updateCompactionSummary(compactionId, "edited summary")).toThrow();
		expect(session.getEntry(compactionId)).toEqual(original);
	});
});
