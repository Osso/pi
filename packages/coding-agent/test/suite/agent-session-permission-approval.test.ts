import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as DesktopNotificationModule from "../../src/core/desktop-notification.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import type { ApprovalPresetName } from "../../src/core/permissions/presets.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

vi.mock("../../src/core/desktop-notification.ts", async (importOriginal) => ({
	...(await importOriginal<typeof DesktopNotificationModule>()),
	sendDesktopNotification: vi.fn(),
}));

function createApprovalUi(select: ExtensionUIContext["select"]): ExtensionUIContext {
	return {
		addAutocompleteProvider: () => {},
		confirm: async () => false,
		custom: async () => undefined as never,
		editor: async () => undefined,
		getAllThemes: () => [],
		getEditorComponent: () => undefined,
		getEditorText: () => "",
		getTheme: () => undefined,
		getToolsExpanded: () => false,
		input: async () => undefined,
		notify: () => {},
		requestRender: () => {},
		onTerminalInput: () => () => {},
		pasteToEditor: () => {},
		select,
		setEditorComponent: () => {},
		setEditorText: () => {},
		setFooter: () => {},
		setDefaultFooter: () => {},
		setHeader: () => {},
		setHiddenThinkingLabel: () => {},
		setStatus: () => {},
		setTheme: () => ({ success: false, error: "not available in tests" }),
		setTitle: () => {},
		setToolsExpanded: () => {},
		setWidget: () => {},
		setWorkingIndicator: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		theme: {} as ExtensionUIContext["theme"],
	};
}

const approvalCases: {
	name: string;
	preset: ApprovalPresetName;
	cached: boolean;
	response: Record<string, unknown>;
	approved: boolean;
}[] = [
	{
		name: "persisted allow skips Supervisor review",
		preset: "llm-approved-deny",
		cached: true,
		response: { behavior: "deny", message: "MCP must not run" },
		approved: true,
	},
	{
		name: "MCP allow skips Supervisor review",
		preset: "llm-approved-deny",
		cached: false,
		response: { behavior: "allow" },
		approved: true,
	},
	{
		name: "MCP allow skips the native selector",
		preset: "ask-me",
		cached: false,
		response: { behavior: "allow" },
		approved: true,
	},
	{
		name: "no MCP decision still reaches Supervisor review",
		preset: "llm-approved-deny",
		cached: false,
		response: { behavior: "prompt" },
		approved: false,
	},
];

describe("AgentSession permission approval propagation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(approvalCases)("$name", async ({ preset, cached, response, approved }) => {
		const executeEcho = vi.fn(async (_toolCallId: string, params: { text: string }) => ({
			content: [{ type: "text" as const, text: params.text }],
			details: {},
		}));
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: executeEcho,
		};
		const executeApproval = vi.fn(async () => ({
			content: [{ type: "text" as const, text: JSON.stringify(response) }],
			details: {},
		}));
		const approvalTool: AgentTool = {
			name: "mcp__approval__prompt",
			label: "Approval",
			description: "Review tool calls",
			parameters: Type.Object({
				tool_name: Type.String(),
				input: Type.Record(Type.String(), Type.Unknown()),
				tool_use_id: Type.String(),
				cwd: Type.String(),
			}),
			execute: executeApproval,
		};
		const supervisorReview = vi.fn(async () => ({ kind: "reject" as const, reason: "Supervisor rejected echo" }));
		const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Deny");
		const hookReview = vi.fn();
		const harness = await createHarness({
			settings: {
				approvalPolicy: "on-request",
				approvalPreset: preset,
				permissionPromptTool: approvalTool.name,
				permissionRules: { allow: { echo: cached ? ['{"text":"hello"}'] : [] } },
			},
			supervisorDecisionRequester: supervisorReview,
			tools: [echoTool, approvalTool],
			uiContext: createApprovalUi(select),
			extensionFactories: [(pi) => pi.on("tool_call", hookReview)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				return fauxAssistantMessage(getMessageText(toolResult));
			},
		]);

		await harness.session.prompt("Echo hello");

		expect(supervisorReview).toHaveBeenCalledTimes(approved ? 0 : 1);
		expect(select).not.toHaveBeenCalled();
		expect(executeApproval).toHaveBeenCalledTimes(cached ? 0 : 1);
		expect(hookReview).toHaveBeenCalledTimes(approved ? 0 : 1);
		expect(executeEcho).toHaveBeenCalledTimes(approved ? 1 : 0);
		expect(getAssistantTexts(harness)).toContain(approved ? "hello" : "Supervisor rejected echo");
	});
});
