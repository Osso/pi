import { describe, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "../src/core/extensions/types.ts";
import {
	createPermissionPromptHandler,
	type PermissionPromptCaller,
	parsePermissionPromptDecision,
} from "../src/core/permissions/mcp-permission-prompt.ts";

function createToolCallEvent(input: Record<string, unknown> = { command: "git status" }): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "toolu_01",
		input,
	};
}

function createHandler(callTool: PermissionPromptCaller, ...permissionPromptTool: [string | undefined] | []) {
	const configuredTool = permissionPromptTool.length === 0 ? "mcp__approval__prompt" : permissionPromptTool[0];

	return createPermissionPromptHandler({
		callTool,
		cwd: "/repo",
		permissionPromptTool: configuredTool,
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
		const handler = createHandler(callTool, undefined);

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).not.toHaveBeenCalled();
	});

	it("falls back when the configured permission prompt tool name is invalid", async () => {
		const callTool = vi.fn<PermissionPromptCaller>();
		const handler = createHandler(callTool, "approval_prompt");

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();

		expect(callTool).not.toHaveBeenCalled();
	});

	it("falls back when the permission prompt call fails", async () => {
		const callTool = vi.fn<PermissionPromptCaller>().mockRejectedValue(new Error("mcp offline"));
		const handler = createHandler(callTool);

		await expect(handler(createToolCallEvent())).resolves.toBeUndefined();
	});
});
