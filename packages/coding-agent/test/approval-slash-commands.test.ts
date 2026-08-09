import { describe, expect, it, vi } from "vitest";
import approvalControlsExtension from "../extensions/approval-controls/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { APPROVAL_PRESETS, SANDBOX_PROFILES } from "../src/core/permissions/presets.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

type TestCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

function createCommandHarness() {
	const commands = new Map<string, TestCommand>();
	const pi = {
		registerCommand(name: string, command: TestCommand) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	approvalControlsExtension(pi);
	return commands;
}

function createSandboxContext() {
	const notify = vi.fn();
	const setEditorText = vi.fn();
	const setSandboxProfile = vi.fn();
	const showSandboxSelector = vi.fn();
	const ctx = {
		setSandboxProfile,
		showSandboxSelector,
		ui: { notify, setEditorText },
	} as unknown as ExtensionCommandContext;
	return { ctx, notify, setEditorText, setSandboxProfile, showSandboxSelector };
}

describe("approval slash commands", () => {
	it("does not register approval and sandbox commands as built-ins", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).not.toContain("approvals");
		expect(commandNames).not.toContain("sandbox");
	});

	it("registers approval and sandbox commands from the approval-controls extension", () => {
		expect([...createCommandHarness().keys()].sort()).toEqual(["approvals", "sandbox"]);
	});

	it("opens the sandbox selector when no direct arguments are provided", async () => {
		const command = createCommandHarness().get("sandbox");
		if (!command) throw new Error("Sandbox command was not registered");
		const { ctx, setEditorText, showSandboxSelector } = createSandboxContext();

		await command.handler("", ctx);

		expect(showSandboxSelector).toHaveBeenCalledOnce();
		expect(setEditorText).toHaveBeenCalledWith("");
	});

	it("sets and clears the exact session override through deterministic arguments", async () => {
		const command = createCommandHarness().get("sandbox");
		if (!command) throw new Error("Sandbox command was not registered");
		const { ctx, notify, setSandboxProfile, showSandboxSelector } = createSandboxContext();

		await command.handler("read-only session", ctx);
		await command.handler("inherit session", ctx);

		expect(showSandboxSelector).not.toHaveBeenCalled();
		expect(setSandboxProfile).toHaveBeenNthCalledWith(1, "read-only", "session");
		expect(setSandboxProfile).toHaveBeenNthCalledWith(2, undefined, "session");
		expect(notify).toHaveBeenNthCalledWith(1, "Sandbox profile: read-only (session)", "info");
		expect(notify).toHaveBeenNthCalledWith(2, "Sandbox profile: inherit (session)", "info");
	});

	it("keeps project and global persistence explicit and rejects invalid arguments", async () => {
		const command = createCommandHarness().get("sandbox");
		if (!command) throw new Error("Sandbox command was not registered");
		const { ctx, notify, setSandboxProfile } = createSandboxContext();

		await command.handler("full-access global", ctx);
		await command.handler("inherit project", ctx);
		await command.handler("read-only", ctx);

		expect(setSandboxProfile).toHaveBeenCalledOnce();
		expect(setSandboxProfile).toHaveBeenCalledWith("full-access", "global");
		expect(notify).toHaveBeenNthCalledWith(2, "Usage: /sandbox [read-only|workspace-write|full-access|inherit] [session|project|global]", "warning");
		expect(notify).toHaveBeenNthCalledWith(3, "Usage: /sandbox [read-only|workspace-write|full-access|inherit] [session|project|global]", "warning");
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
