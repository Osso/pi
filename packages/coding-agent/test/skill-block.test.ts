import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/skill-block.ts";

describe("parseSkillBlock", () => {
	it("parses a skill block with trailing user message", () => {
		const parsed = parseSkillBlock(
			'<skill name="verify" location="/tmp/SKILL.md">\nCheck the output\n</skill>\n\nRun the proof',
		);

		expect(parsed).toEqual({
			name: "verify",
			location: "/tmp/SKILL.md",
			content: "Check the output",
			userMessage: "Run the proof",
		});
	});

	it("returns null for normal message text", () => {
		expect(parseSkillBlock("Run the proof")).toBeNull();
	});
});
