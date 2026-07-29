import { describe, expect, it } from "vitest";
import { createAllToolDefinitions, createTool, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";

describe("end_turn tool", () => {
	it("is a default built-in tool that terminates with its required reason", async () => {
		const definitions = createAllToolDefinitions(process.cwd());
		const tool = createTool("end_turn", process.cwd());

		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("end_turn");
		expect(definitions.end_turn.name).toBe("end_turn");
		await expect(tool.execute("end-missing", {})).rejects.toThrow("Invalid arguments for tool end_turn");
		await expect(tool.execute("end-blank", { reason: "  " })).rejects.toThrow(
			"end_turn reason must be a non-empty string",
		);

		const result = await tool.execute("end-valid", { reason: "Finished requested work" });
		expect(result).toEqual({
			content: [{ type: "text", text: "Turn ended: Finished requested work" }],
			details: { reason: "Finished requested work" },
			terminate: true,
		});
	});
});
