import { describe, expect, it } from "vitest";
import approvalControlsExtension from "../extensions/approval-controls/src/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { APPROVAL_PRESETS, SANDBOX_PROFILES } from "../src/core/permissions/presets.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("approval slash commands", () => {
	it("does not register approval and sandbox commands as built-ins", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).not.toContain("approvals");
		expect(commandNames).not.toContain("sandbox");
	});

	it("registers approval and sandbox commands from the approval-controls extension", () => {
		const commandNames: string[] = [];
		const pi = {
			registerCommand(name: string) {
				commandNames.push(name);
			},
		} as unknown as ExtensionAPI;

		approvalControlsExtension(pi);

		expect(commandNames.sort()).toEqual(["approvals", "sandbox"]);
	});

	it("keeps approval presets distinct from sandbox profiles", () => {
		expect(APPROVAL_PRESETS.map((preset) => preset.name)).toEqual([
			"ask-me",
			"llm-approved-deny",
			"llm-approved-ask",
			"never-ask-deny",
			"auto-approve",
		]);
		expect(APPROVAL_PRESETS.map((preset) => preset.policy)).toEqual([
			"on-request",
			"on-request",
			"on-request",
			"never",
			"auto-approve",
		]);
		expect(APPROVAL_PRESETS.map((preset) => preset.reviewer)).toEqual([
			"human",
			"llm-deny",
			"llm-ask",
			"none",
			"none",
		]);

		expect(SANDBOX_PROFILES.map((profile) => profile.name)).toEqual(["read-only", "workspace-write", "full-access"]);
		expect(SANDBOX_PROFILES.every((profile) => !("policy" in profile))).toBe(true);
	});
});
