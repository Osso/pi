import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ApprovalSelectorComponent } from "../src/modes/interactive/components/approval-selector.ts";
import { SandboxSelectorComponent } from "../src/modes/interactive/components/sandbox-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("approval and sandbox selectors", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
	});

	afterEach(() => vi.unstubAllGlobals());

	it("renders approval presets with the active preset marked", () => {
		const selector = new ApprovalSelectorComponent({
			currentPreset: "llm-approved-deny",
			onCancel: () => {},
			onSelect: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Approval presets");
		expect(output).toContain("Ask Me");
		expect(output).toContain("LLM Approved (and deny) ✓");
		expect(output).toContain("LLM Approved (and ask)");
		expect(output).toContain("Never Ask/Deny");
		expect(output).toContain("Auto Approve");
	});

	it("selects an approval preset for project settings", () => {
		const onSelect = vi.fn();
		const selector = new ApprovalSelectorComponent({
			currentPreset: "ask-me",
			onCancel: () => {},
			onSelect,
		});

		selector.handleInput("j");
		selector.handleInput("\t");
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ preset: "llm-approved-deny", scope: "project" });
	});

	it("renders sandbox profiles without approval-policy labels", () => {
		const selector = new SandboxSelectorComponent({
			currentProfile: "workspace-write",
			onCancel: () => {},
			onSelect: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Sandbox profiles");
		expect(output).toContain("Read Only");
		expect(output).toContain("Default/Workspace Write ✓");
		expect(output).toContain("Full Access");
		expect(output).not.toContain("auto-approve");
		expect(output).not.toContain("never");
	});

	it("marks sandbox-required profiles unsupported on Darwin without changing explicit selections", () => {
		vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
		const onSelect = vi.fn();
		const selector = new SandboxSelectorComponent({
			currentProfile: "read-only",
			onCancel: () => {},
			onSelect,
		});
		const output = stripAnsi(selector.render(140).join("\n"));
		expect(output).toContain("Read Only (unsupported on darwin; Linux only) ✓");
		expect(output).toContain("Default/Workspace Write (unsupported on darwin; Linux only)");
		expect(output).toContain("Full Access");
		expect(output).not.toContain("Full Access (unsupported");
		selector.handleInput("\n");
		expect(onSelect).toHaveBeenCalledWith({ profile: "read-only", scope: "global" });
	});

	it("selects a sandbox profile for global settings", () => {
		const onSelect = vi.fn();
		const selector = new SandboxSelectorComponent({
			currentProfile: "workspace-write",
			onCancel: () => {},
			onSelect,
		});

		selector.handleInput("j");
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ profile: "full-access", scope: "global" });
	});

	it("shows and selects inherited settings for session scope", () => {
		const onSelect = vi.fn();
		const selector = new SandboxSelectorComponent({
			currentProfile: "full-access",
			onCancel: () => {},
			onSelect,
			sessionProfile: undefined,
		});

		selector.handleInput("\t");
		selector.handleInput("\t");
		const output = stripAnsi(selector.render(120).join("\n"));
		selector.handleInput("\n");

		expect(output).toContain("Save scope: session");
		expect(output).toContain("Inherit global/project ✓");
		expect(onSelect).toHaveBeenCalledWith({ profile: undefined, scope: "session" });
	});

	it("marks the active session override independently from the configured profile", () => {
		const selector = new SandboxSelectorComponent({
			currentProfile: "full-access",
			onCancel: () => {},
			onSelect: () => {},
			sessionProfile: "read-only",
		});

		selector.handleInput("\t");
		selector.handleInput("\t");
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Read Only ✓");
		expect(output).not.toContain("Inherit global/project ✓");
	});
});
