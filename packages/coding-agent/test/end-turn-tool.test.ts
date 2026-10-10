import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { isServerNarrationSignature } from "../src/core/tools/end-turn.ts";
import { createAllToolDefinitions, createTool, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tools/index.ts";

// Leading bytes of signatures captured from a Claude Code bridge transcript.
const NARRATION_SIGNATURE = "CAQS6BEKEQgSGAI4AUIJbmFycmF0aW9uEgyhMvH4";
const THINKING_SIGNATURE = "CAQS6AkKEAgSGAI4AUIIdGhpbmtpbmcSDHvhDiEB";

describe("end_turn tool", () => {
	it("is a default built-in tool that terminates with its required reason", async () => {
		const definitions = createAllToolDefinitions(process.cwd());
		const tool = createTool("end_turn", process.cwd());

		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("end_turn");
		expect(definitions.end_turn.name).toBe("end_turn");
		expect(definitions.end_turn.promptGuidelines).toContain(
			"Call end_turn only when the task is complete, progress requires user input, or the user explicitly asks you to stop. If work remains and progress is possible, continue working instead of calling end_turn. Assistant text alone does not finish the turn.",
		);
		expect(definitions.end_turn.promptGuidelines).toContain(
			"Thinking is never shown to the user. When responding to the user, write the reply as assistant text before calling end_turn; never leave an answer only in thinking.",
		);
		expect(Value.Check(definitions.end_turn.parameters, {})).toBe(false);
		await expect(tool.execute("end-blank", { reason: "  " })).rejects.toThrow(
			"end_turn reason must be a non-empty string",
		);

		expect(isServerNarrationSignature(NARRATION_SIGNATURE)).toBe(true);
		expect(isServerNarrationSignature(THINKING_SIGNATURE)).toBe(false);
		expect(isServerNarrationSignature("rs_0123abc")).toBe(false);

		const result = await tool.execute("end-valid", { reason: "Finished requested work" });
		expect(result).toEqual({
			content: [{ type: "text", text: "Turn ended: Finished requested work" }],
			details: { reason: "Finished requested work" },
			terminate: true,
		});
	});
});
