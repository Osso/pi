import { describe, expect, it } from "vitest";
import { approvalPresetToBypassPermissions } from "../src/core/permissions/presets.ts";

describe("approval hook compatibility", () => {
	it("never maps to bypassPermissions=false", () => {
		expect(approvalPresetToBypassPermissions("never-ask-deny")).toBe(false);
	});

	it("auto-approve maps to bypassPermissions=true", () => {
		expect(approvalPresetToBypassPermissions("auto-approve")).toBe(true);
	});

	it("reviewed approval presets map to bypassPermissions=false", () => {
		expect(approvalPresetToBypassPermissions("ask-me")).toBe(false);
		expect(approvalPresetToBypassPermissions("llm-approved-deny")).toBe(false);
		expect(approvalPresetToBypassPermissions("llm-approved-ask")).toBe(false);
	});
});
