import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getControlDbPath, writeSessionHealth, writeSessionMetadata } from "../src/core/session-control-db.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";
import { createChannelPostToolDefinition } from "../src/core/tools/channel-post.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";
import { createListSessionsToolDefinition } from "../src/core/tools/list-sessions.ts";

describe("session coordination tools", () => {
	it("registers session coordination tools as built-ins active by default", () => {
		const tools = createAllToolDefinitions("/tmp");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("list_sessions");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("broadcast");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("channel_post");
		expect(tools.list_sessions.name).toBe("list_sessions");
		expect(tools.broadcast.name).toBe("broadcast");
		expect(tools.channel_post.name).toBe("channel_post");
		expect(tools.list_sessions.description).toContain("sticky liveness");
		expect(tools.broadcast.description).toContain("eligible");
		expect(tools.channel_post.description).toContain("shared channel");
	});

	it("excludes ended rows when list_sessions receives include_ended false", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-list-sessions-tool-"));
		try {
			const controlDbPath = getControlDbPath(agentDir);
			writeSessionMetadata(controlDbPath, {
				sessionPath: "/sessions/ended.jsonl",
				id: "ended",
				cwd: "/repo/ended",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:10:00.000Z",
				messageCount: 1,
				firstMessage: "hello",
				allMessagesText: "hello",
			});
			writeSessionHealth(controlDbPath, {
				...emptySessionHealth("ended"),
				agentGeneration: 1,
				checkStatus: "dead",
				checkedGeneration: 1,
			});
			const tool = createListSessionsToolDefinition();

			const result = await tool.execute("list-sessions", { include_ended: false }, undefined, undefined, {
				controlDbPath,
				sessionManager: { getSessionId: () => "current-without-metadata" },
			} as Parameters<typeof tool.execute>[4]);

			expect(result.details?.sessions).toEqual([]);
			expect(result.content).toEqual([{ type: "text", text: "No sessions found." }]);
		} finally {
			rmSync(agentDir, { force: true, recursive: true });
		}
	});

	it("rejects channel_post from subagent contexts by default", async () => {
		const tool = createChannelPostToolDefinition();

		await expect(
			tool.execute("channel-post", { message: "hello" }, undefined, undefined, {
				multiAgentAgentId: "agent_1",
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("channel_post is only available from main sessions");
	});
});
