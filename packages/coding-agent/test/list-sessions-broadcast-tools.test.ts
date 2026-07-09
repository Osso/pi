import { describe, expect, it } from "vitest";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";

describe("list_sessions and broadcast tools", () => {
	it("registers both tools as built-ins active by default", () => {
		const tools = createAllToolDefinitions("/tmp");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("list_sessions");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("broadcast");
		expect(tools.list_sessions.name).toBe("list_sessions");
		expect(tools.broadcast.name).toBe("broadcast");
		expect(tools.list_sessions.description).toContain("sticky liveness");
		expect(tools.broadcast.description).toContain("eligible");
	});
});
