import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";
import { createSearchCurrentSessionHistoryToolDefinition } from "../src/core/tools/search-current-session-history.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { force: true, recursive: true });
	}
});

function createSessionManager(): SessionManager {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-session-history-search-"));
	tempDirs.push(tempDir);
	return SessionManager.create("/repo", join(tempDir, "sessions"));
}

function toolContext(sessionManager: SessionManager) {
	return { sessionManager } as unknown as Parameters<
		ReturnType<typeof createSearchCurrentSessionHistoryToolDefinition>["execute"]
	>[4];
}

describe("search_current_session_history", () => {
	it("searches full active-branch entries hidden by compaction and includes neighboring entries", async () => {
		const sessionManager = createSessionManager();
		const firstId = sessionManager.appendMessage({
			role: "user",
			content: "Original deployment used cobalt",
			timestamp: 1,
		});
		const keptId = sessionManager.appendMessage({
			role: "user",
			content: "Neighbor before compaction",
			timestamp: 2,
		});
		sessionManager.appendCompaction("Earlier deployment discussion", keptId, 1000);
		sessionManager.appendMessage({ role: "user", content: "Current follow-up", timestamp: 3 });
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		const result = await tool.execute(
			"search-history",
			{ query: "COBALT", context_entries: 1 },
			undefined,
			undefined,
			toolContext(sessionManager),
		);

		expect(result.details?.totalMatches).toBe(1);
		expect(result.details?.entries).toEqual([
			expect.objectContaining({ id: firstId, matched: true, compacted: true, role: "user" }),
			expect.objectContaining({ matched: false, content: "Neighbor before compaction", role: "user" }),
		]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("Original deployment used cobalt"),
		});
	});

	it("excludes entries from inactive branches", async () => {
		const sessionManager = createSessionManager();
		const rootId = sessionManager.appendMessage({ role: "user", content: "shared root", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "inactive branch secret", timestamp: 2 });
		sessionManager.branch(rootId);
		sessionManager.appendMessage({ role: "user", content: "active branch", timestamp: 3 });
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		const result = await tool.execute(
			"search-history",
			{ query: "inactive branch secret" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);

		expect(result.details?.totalMatches).toBe(0);
		expect(result.details?.entries).toEqual([]);
		expect(result.content).toEqual([{ type: "text", text: "No matches found in current session history." }]);
	});

	it("paginates matches while returning full matching content", async () => {
		const sessionManager = createSessionManager();
		sessionManager.appendMessage({ role: "user", content: "needle one", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "needle two", timestamp: 2 });
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		const firstPage = await tool.execute(
			"search-history",
			{ query: "needle", limit: 1 },
			undefined,
			undefined,
			toolContext(sessionManager),
		);
		expect(firstPage.details).toEqual(
			expect.objectContaining({ totalMatches: 2, returnedMatches: 1, nextCursor: "1" }),
		);
		expect(firstPage.details?.entries[0]).toEqual(expect.objectContaining({ content: "needle one", matched: true }));

		const secondPage = await tool.execute(
			"search-history",
			{ query: "needle", limit: 1, cursor: firstPage.details?.nextCursor },
			undefined,
			undefined,
			toolContext(sessionManager),
		);
		expect(secondPage.details).toEqual(
			expect.objectContaining({ totalMatches: 2, returnedMatches: 1, nextCursor: undefined }),
		);
		expect(secondPage.details?.entries[0]).toEqual(expect.objectContaining({ content: "needle two", matched: true }));
	});

	it("requires a persisted current session", async () => {
		const tool = createSearchCurrentSessionHistoryToolDefinition();
		const context = {
			sessionManager: {
				getSessionFile: () => undefined,
				getBranch: () => [],
				buildContextEntries: () => [],
			},
		} as unknown as Parameters<typeof tool.execute>[4];

		await expect(tool.execute("search-history", { query: "needle" }, undefined, undefined, context)).rejects.toThrow(
			"search_current_session_history requires a persisted current session",
		);
	});

	it("is registered as a default active built-in tool", () => {
		const tools = createAllToolDefinitions("/repo");

		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("search_current_session_history");
		expect(tools.search_current_session_history.name).toBe("search_current_session_history");
	});
});
