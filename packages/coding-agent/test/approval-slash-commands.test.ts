import { describe, expect, it } from "vitest";
import { APPROVAL_PRESETS, SANDBOX_PROFILES } from "../src/core/permissions/presets.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("approval slash commands", () => {
	it("registers approval and sandbox commands as built-ins", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).toContain("approvals");
		expect(commandNames).toContain("sandbox");
	});

	it("keeps approval presets distinct from sandbox profiles", () => {
		expect(APPROVAL_PRESETS.map((preset) => preset.name)).toEqual([
			"ask-me",
			"llm-approved",
			"never-ask-deny",
			"auto-approve",
		]);
		expect(APPROVAL_PRESETS.map((preset) => preset.policy)).toEqual([
			"on-request",
			"on-request",
			"never",
			"auto-approve",
		]);
		expect(APPROVAL_PRESETS.map((preset) => preset.reviewer)).toEqual(["human", "llm", "none", "none"]);

		expect(SANDBOX_PROFILES.map((profile) => profile.name)).toEqual(["read-only", "workspace-write", "full-access"]);
		expect(SANDBOX_PROFILES.every((profile) => !("policy" in profile))).toBe(true);
	});
});
