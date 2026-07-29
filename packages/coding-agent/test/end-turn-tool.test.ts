import { describe, expect, it } from "vitest";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";

describe("end_turn tool", () => {
	it("is a default built-in tool that terminates with its required reason", async () => {
		const tools = createAllToolDefinitions(process.cwd());
		const tool = tools.end_turn;

		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("end_turn");
		expect(tool.name).toBe("end_turn");
		await expect(tool.execute("end-1", { reason: "  " })).rejects.toThrow(
			"end_turn reason must be a non-empty string",
		);

		const result = await tool.execute("end-2", { reason: "Finished requested work" });
		expect(result).toEqual({
			content: [{ type: "text", text: "Turn ended: Finished requested work" }],
			details: { reason: "Finished requested work" },
			terminate: true,
		});
	});
});
