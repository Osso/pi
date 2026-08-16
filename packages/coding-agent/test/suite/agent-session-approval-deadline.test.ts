import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

interface AgentSessionActivityPublisher {
	_publishCurrentAgentActivity(event: AgentEvent): void;
}

const publishCurrentAgentActivity = (AgentSession.prototype as unknown as AgentSessionActivityPublisher)
	._publishCurrentAgentActivity;
const THINKING_PHASE_TIMEOUT_MS = 1_000;
const APPROVAL_WAIT_MS = 60_000;
const UI_CONTEXT_BASE = {
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
	setDefaultFooter: () => {},
	setEditorComponent: () => {},
	setEditorText: () => {},
	setFooter: () => {},
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
} satisfies Omit<ExtensionUIContext, "select">;

function createUiContext(select: ExtensionUIContext["select"]): ExtensionUIContext {
	return { ...UI_CONTEXT_BASE, select };
}

function requestHumanApproval(pi: ExtensionAPI): void {
	pi.registerApprovalReviewer(async () => ({ action: "ask", reason: "needs human approval" }));
}

describe("AgentSession approval deadline", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not count a pending human approval against the thinking-phase deadline", async () => {
		vi.useFakeTimers();
		let markApprovalStarted: (() => void) | undefined;
		let resolveApproval: ((selection: string | undefined) => void) | undefined;
		const approvalStarted = new Promise<void>((resolve) => {
			markApprovalStarted = resolve;
		});
		const approvalSelection = new Promise<string | undefined>((resolve) => {
			resolveApproval = resolve;
		});
		const select = vi.fn<ExtensionUIContext["select"]>(async () => {
			markApprovalStarted?.();
			return approvalSelection;
		});
		const tool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect a target",
			parameters: Type.Object({ target: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const harness = await createHarness({
			extensionFactories: [requestHumanApproval],
			settings: { approvalPolicy: "on-request", approvalPreset: "ask-me" },
			thinkingPhaseTimeoutMs: THINKING_PHASE_TIMEOUT_MS,
			tools: [tool],
			uiContext: createUiContext(select),
		});
		harnesses.push(harness);
		const abort = vi.spyOn(harness.session.agent, "abort");
		publishCurrentAgentActivity.call(harness.session, { type: "agent_start" });

		const toolCall = fauxToolCall("inspect", { target: "src" });
		const approval = harness.session.agent.beforeToolCall?.({
			assistantMessage: fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
			args: { target: "src" },
			context: {
				messages: [],
				systemPrompt: harness.session.agent.state.systemPrompt,
				tools: harness.session.agent.state.tools,
			},
			toolCall,
		});
		if (!approval) throw new Error("Expected AgentSession tool approval hook");
		await approvalStarted;
		await vi.advanceTimersByTimeAsync(APPROVAL_WAIT_MS);
		const abortCallsDuringApproval = abort.mock.calls.length;

		resolveApproval?.("Allow once");
		await expect(approval).resolves.toEqual({ block: false });
		expect(abortCallsDuringApproval).toBe(0);
	});
});
