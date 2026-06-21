import { describe, expect, it } from "vitest";
import type { ApprovalPresetName } from "../src/core/permissions/presets.ts";
import * as approvalPresets from "../src/core/permissions/presets.ts";

type HookCompatibilityExports = {
	approvalPresetToBypassPermissions?: (preset: ApprovalPresetName) => boolean;
};

const compatibility = approvalPresets as HookCompatibilityExports;

describe("approval hook compatibility", () => {
	it("never maps to bypassPermissions=false", () => {
		expect(compatibility.approvalPresetToBypassPermissions?.("never-ask-deny")).toBe(false);
	});

	it("auto-approve maps to bypassPermissions=true", () => {
		expect(compatibility.approvalPresetToBypassPermissions?.("auto-approve")).toBe(true);
	});

	it("reviewed approval presets map to bypassPermissions=false", () => {
		expect(compatibility.approvalPresetToBypassPermissions?.("ask-me")).toBe(false);
		expect(compatibility.approvalPresetToBypassPermissions?.("llm-approved")).toBe(false);
	});
});
