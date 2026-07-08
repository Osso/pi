import { describe, expect, it, vi } from "vitest";
import { NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS } from "../src/core/desktop-notification.ts";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";
import {
	createPermissionPromptHandler,
	type PermissionPromptCaller,
	parsePermissionPromptDecision,
} from "../src/core/permissions/mcp-permission-prompt.ts";
import { PermissionRuleStore } from "../src/core/permissions/rule-store.ts";

function createToolCallEvent(input: Record<string, unknown> = { command: "git status" }): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "toolu_01",
		bypassPermissions: false,
		input,
	};
}

function createHandler(
	callTool: PermissionPromptCaller,
	options: {
		desktopNotifier?: (notification: { body: string; title: string }) => undefined | { close(): void };
		permissionPromptTool?: string;
		ruleStore?: PermissionRuleStore;
	} = {},
) {
	const configuredTool = "permissionPromptTool" in options ? options.permissionPromptTool : "mcp__approval__prompt";

	return createPermissionPromptHandler({
		callTool,
		cwd: "/repo",
		desktopNotifier: options.desktopNotifier,
		permissionPromptTool: configuredTool,
		ruleStore: options.ruleStore,
	});
}

describe("parsePermissionPromptDecision", () => {
	it("parses allow decisions", () => {
		expect(parsePermissionPromptDecision('{"behavior":"allow"}')).toEqual({ behavior: "allow" });
	});

	it("parses allow decisions with updated input", () => {
		expect(
			parsePermissionPromptDecision('{"behavior":"allow","updatedInput":{"command":"git status --short"}}'),
		).toEqual({
			behavior: "allow",
			updatedInput: { command: "git status --short" },
		});
	});

	it("parses allow decisions with updated permissions", () => {
		expect(
			parsePermissionPromptDecision(
				'{"behavior":"allow","updatedPermissions":[{"type":"addRules","destination":"session","behavior":"allow","rules":["git status"]}]}',
			),
		).toEqual({
			behavior: "allow",
			updatedPermissions: [
				{
					type: "addRules",
					destination: "session",
					behavior: "allow",
					rules: ["git status"],
				},
			],
		});
	});

	it("parses deny decisions", () => {
		expect(parsePermissionPromptDecision('{"behavior":"deny","message":"blocked"}')).toEqual({
			behavior: "deny",
			message: "blocked",
		});
	});

	it("falls back for malformed decisions", () => {
		expect(parsePermissionPromptDecision("not json")).toBeUndefined();
		expect(parsePermissionPromptDecision('{"updatedInput":{}}')).toBeUndefined();
		expect(parsePermissionPromptDecision('{"behavior":"prompt"}')).toBeUndefined();
		expect(parsePermissionPromptDecision('{"behavior":"allow","updatedInput":[]}')).toBeUndefined();
	});
});

describe("createPermissionPromptHandler", () => {
	it("allows tool calls without further prompting", async () => {
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"allow"}');
		const handler = createHandler(callTool);
		const event = createToolCallEvent();

		await expect(handler(event)).resolves.toBeUndefined();

		expect(event.input).toEqual({ command: "git status" });
		expect(callTool).toHaveBeenCalledWith("mcp__approval__prompt", {
			cwd: "/repo",
			input: { command: "git status" },
			tool_name: "bash",
			tool_use_id: "toolu_01",
		});
	});

	it("sends a desktop notification before calling the permission prompt tool", async () => {
		const desktopNotifier = vi.fn();
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"allow"}');
		const handler = createHandler(callTool, { desktopNotifier });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(desktopNotifier).toHaveBeenCalledWith({
			body: "Permission approval needed for bash in /repo.",
			expireTimeMs: NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS,
			title: "Pi permission approval needed",
		});
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it("does not expose permission prompt input in desktop notifications", async () => {
		const desktopNotifier = vi.fn();
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"allow"}');
		const handler = createHandler(callTool, { desktopNotifier });

		await expect(
			handler(createToolCallEvent({ command: "curl -H 'Authorization: Bearer secret-token'" })),
		).resolves.toBeUndefined();

		expect(desktopNotifier.mock.calls[0]?.[0].body).not.toContain("secret-token");
		expect(desktopNotifier.mock.calls[0]?.[0].body).not.toContain("Authorization");
	});

	it("continues permission prompts when desktop notification fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const desktopNotifier = vi.fn(() => {
			throw new Error("notify-send missing");
		});
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"allow"}');
		const handler = createHandler(callTool, { desktopNotifier });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledOnce();
		consoleError.mockRestore();
	});

	it("closes the desktop notification after the permission prompt resolves", async () => {
		const close = vi.fn();
		const desktopNotifier = vi.fn(() => ({ close }));
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"deny","message":"blocked"}');
		const handler = createHandler(callTool, { desktopNotifier });

		await expect(handler(createToolCallEvent())).resolves.toEqual({ block: true, reason: "blocked" });

		expect(close).toHaveBeenCalledOnce();
	});

	it("continues permission prompts when desktop notification close fails", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const close = vi.fn(() => {
			throw new Error("close failed");
		});
		const desktopNotifier = vi.fn(() => ({ close }));
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"allow"}');
		const handler = createHandler(callTool, { desktopNotifier });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledOnce();
		expect(consoleError).toHaveBeenCalledWith(
			"Failed to close permission prompt desktop notification:",
			expect.any(Error),
		);
		consoleError.mockRestore();
	});

	it("allows tool calls with updated input", async () => {
		const originalInput = { command: "git status" };
		const callTool = vi
			.fn<PermissionPromptCaller>()
			.mockResolvedValue('{"behavior":"allow","updatedInput":{"command":"git status --short"}}');
		const handler = createHandler(callTool);
		const event = createToolCallEvent(originalInput);

		await expect(handler(event)).resolves.toBeUndefined();

		expect(event.input).toBe(originalInput);
		expect(event.input).toEqual({ command: "git status --short" });
	});

	it("blocks denied tool calls", async () => {
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"deny","message":"blocked"}');
		const handler = createHandler(callTool);

		await expect(handler(createToolCallEvent())).resolves.toEqual({ block: true, reason: "blocked" });
	});

	it("falls back when the permission prompt returns malformed output", async () => {
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue('{"behavior":"prompt"}');
		const handler = createHandler(callTool);

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();
	});

	it("falls back when no permission prompt tool is configured", async () => {
		const callTool = vi.fn<PermissionPromptCaller>();
		const handler = createHandler(callTool, { permissionPromptTool: undefined });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).not.toHaveBeenCalled();
	});

	it("falls back when the configured permission prompt tool name is invalid", async () => {
		const callTool = vi.fn<PermissionPromptCaller>();
		const handler = createHandler(callTool, { permissionPromptTool: "approval_prompt" });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).not.toHaveBeenCalled();
	});

	it("falls back when the permission prompt call fails", async () => {
		const callTool = vi.fn<PermissionPromptCaller>().mockRejectedValue(new Error("mcp offline"));
		const handler = createHandler(callTool);

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();
	});

	it("uses session allow rules to skip future permission prompt calls", async () => {
		const ruleStore = new PermissionRuleStore();
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue(
			JSON.stringify({
				behavior: "allow",
				updatedPermissions: [
					{
						type: "addRules",
						destination: "session",
						behavior: "allow",
						rules: ["git status"],
					},
				],
			}),
		);
		const handler = createHandler(callTool, { ruleStore });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();
		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it("does not use non-session allow rules to skip follow-up prompts in the same session", async () => {
		const writer = vi.fn();
		const ruleStore = new PermissionRuleStore({
			agentDir: "/agent",
			cwd: "/repo",
			writer,
		});
		const callTool = vi.fn<PermissionPromptCaller>().mockResolvedValue(
			JSON.stringify({
				behavior: "allow",
				updatedPermissions: [
					{
						type: "addRules",
						destination: "userSettings",
						behavior: "allow",
						rules: ["git status"],
					},
				],
			}),
		);
		const handler = createHandler(callTool, { ruleStore });

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();
		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).toHaveBeenCalledTimes(2);
		expect(writer).toHaveBeenCalledTimes(2);
	});
});
