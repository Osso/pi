import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("search_current_session_history", () => {
	it("matches user messages and assistant text case-insensitively", async () => {
		const sessionManager = createSessionManager();
		sessionManager.appendMessage({ role: "user", content: "list-skills", timestamp: 1 });
		sessionManager.appendMessage(
			assistantMessage([{ type: "text", text: "Available skills include reddit and /tmp/pi-clipboard-image.png" }]),
		);
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		const userMatch = await tool.execute(
			"search-history",
			{ query: "list-skills" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);
		const assistantMatch = await tool.execute(
			"search-history",
			{ query: "REDDIT" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);

		expect(userMatch.details?.totalMatches).toBe(1);
		expect(userMatch.details?.entries).toEqual([
			expect.objectContaining({ role: "user", content: "list-skills", matched: true }),
		]);
		expect(assistantMatch.details?.totalMatches).toBe(1);
		expect(assistantMatch.details?.entries).toEqual([
			expect.objectContaining({ role: "assistant", matched: true }),
		]);
	});

	it("matches tool-call names and nested arguments, but not signatures", async () => {
		const sessionManager = createSessionManager();
		const callId = sessionManager.appendMessage(
			assistantMessage([
				{
					type: "toolCall",
					id: "read-config",
					name: "read",
					arguments: { path: "/etc/cobalt.conf", options: { offset: 42, enabled: true } },
					thoughtSignature: "opaque-tool-signature",
				},
			]),
		);
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		for (const query of ["READ", "COBALT", "offset", "42", "true"]) {
			const result = await tool.execute("search-history", { query }, undefined, undefined, toolContext(sessionManager));
			expect(result.details?.totalMatches).toBe(1);
			expect(result.details?.entries).toEqual([expect.objectContaining({ id: callId, matched: true })]);
		}
		const signature = await tool.execute(
			"search-history",
			{ query: "opaque-tool-signature" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);
		expect(signature.details?.totalMatches).toBe(0);
	});

	it("matches tool results hidden by compaction", async () => {
		const sessionManager = createSessionManager();
		sessionManager.appendMessage({ role: "user", content: "Read configuration", timestamp: 1 });
		const resultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "read-config",
			toolName: "read",
			content: [{ type: "text", text: "Deployment region: cobalt" }],
			isError: false,
			timestamp: 2,
		});
		const keptId = sessionManager.appendMessage({ role: "user", content: "Continue", timestamp: 3 });
		sessionManager.appendCompaction("Configuration inspected", keptId, 1000);
		const tool = createSearchCurrentSessionHistoryToolDefinition();
		const result = await tool.execute(
			"search-history",
			{ query: "COBALT" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);

		expect(result.details?.totalMatches).toBe(1);
		expect(result.details?.entries).toEqual([
			expect.objectContaining({ id: resultId, role: "toolResult", matched: true, compacted: true }),
		]);
	});

	it("matches custom messages, compaction summaries, and active branch summaries", async () => {
		const sessionManager = createSessionManager();
		const rootId = sessionManager.appendMessage({ role: "user", content: "Start deployment", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "abandoned-path-marker", timestamp: 2 });
		const branchId = sessionManager.branchWithSummary(rootId, "Cobalt branch decision");
		const customId = sessionManager.appendCustomMessageEntry("deployment-note", "Cobalt custom note", true);
		const compactionId = sessionManager.appendCompaction("Cobalt compaction summary", customId, 1000);
		const tool = createSearchCurrentSessionHistoryToolDefinition();
		const result = await tool.execute(
			"search-history",
			{ query: "COBALT" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);

		expect(result.details?.totalMatches).toBe(3);
		expect(result.details?.entries).toEqual([
			expect.objectContaining({ id: branchId, entryType: "branch_summary", matched: true, compacted: true }),
			expect.objectContaining({ id: customId, entryType: "custom_message", matched: true, compacted: false }),
			expect.objectContaining({ id: compactionId, entryType: "compaction", matched: true, compacted: false }),
		]);
		const inactive = await tool.execute(
			"search-history",
			{ query: "abandoned-path-marker" },
			undefined,
			undefined,
			toolContext(sessionManager),
		);
		expect(inactive.details?.totalMatches).toBe(0);
	});

	it("does not match its own prior calls or results while searching other blocks in the same message", async () => {
		const sessionManager = createSessionManager();
		const assistantId = sessionManager.appendMessage(
			assistantMessage([
				{
					type: "toolCall",
					id: "prior-search",
					name: "search_current_session_history",
					arguments: { query: "self-match" },
				},
				{ type: "text", text: "Unrelated assistant marker" },
				{ type: "toolCall", id: "other-call", name: "read", arguments: { path: "/etc/other-config" } },
			]),
		);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "prior-search",
			toolName: "search_current_session_history",
			content: [{ type: "text", text: "self-match returned-result-marker" }],
			details: { query: "self-match" },
			isError: false,
			timestamp: 3,
		});
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		for (const query of ["self-match", "returned-result-marker", "search_current_session_history"]) {
			const result = await tool.execute("search-history", { query }, undefined, undefined, toolContext(sessionManager));
			expect(result.details?.totalMatches).toBe(0);
			expect(result.details?.entries).toEqual([]);
		}
		for (const query of ["assistant marker", "other-config"]) {
			const result = await tool.execute("search-history", { query }, undefined, undefined, toolContext(sessionManager));
			expect(result.details?.entries).toEqual([expect.objectContaining({ id: assistantId, matched: true })]);
		}
	});

	it("does not match thinking blocks or content signatures", async () => {
		const sessionManager = createSessionManager();
		sessionManager.appendMessage(
			assistantMessage([
				{ type: "thinking", thinking: "private-reasoning-marker", thinkingSignature: "opaque-thinking-signature" },
				{ type: "text", text: "Visible answer", textSignature: "opaque-text-signature" },
			]),
		);
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		for (const query of ["private-reasoning-marker", "opaque-thinking-signature", "opaque-text-signature"]) {
			const result = await tool.execute("search-history", { query }, undefined, undefined, toolContext(sessionManager));
			expect(result.details?.totalMatches).toBe(0);
		}
	});

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

	it("matches literal multiline and escaped characters in message content", async () => {
		const sessionManager = createSessionManager();
		const content = `alpha
beta says "quoted" at C:\\tmp`;
		sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
		const tool = createSearchCurrentSessionHistoryToolDefinition();

		const result = await tool.execute(
			"search-history",
			{ query: content },
			undefined,
			undefined,
			toolContext(sessionManager),
		);

		expect(result.details?.totalMatches).toBe(1);
		expect(result.details?.entries[0]).toEqual(expect.objectContaining({ content, matched: true }));
	});

	it("paginates matches while returning full matching content", async () => {
		const sessionManager = createSessionManager();
		sessionManager.appendMessage({ role: "user", content: "needle one", timestamp: 1 });
		sessionManager.appendMessage(assistantMessage([{ type: "text", text: "needle two" }]));
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
		expect(secondPage.details?.entries[0]).toEqual(
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "needle two" }], matched: true }),
		);
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
