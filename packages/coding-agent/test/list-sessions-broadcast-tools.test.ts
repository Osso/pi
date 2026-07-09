import { describe, expect, it } from "vitest";
import { createChannelPostToolDefinition } from "../src/core/tools/channel-post.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";

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

	it("rejects channel_post from subagent contexts by default", async () => {
		const tool = createChannelPostToolDefinition();

		await expect(
			tool.execute("channel-post", { message: "hello" }, undefined, undefined, {
				multiAgentAgentId: "agent_1",
			} as Parameters<typeof tool.execute>[4]),
		).rejects.toThrow("channel_post is only available from main sessions");
	});
});
