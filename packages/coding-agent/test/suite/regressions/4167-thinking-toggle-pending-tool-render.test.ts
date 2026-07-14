import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionItems = (
	this: RenderSessionContextThis,
	items: AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string };
	session: { retryAttempt: number };
	toolOutputExpanded: boolean;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	completedToolTimings: Map<string, { startedAt: number; finishedAt: number }>;
	clearToolExecutionTrackingFor(toolCallId: string): void;
	getPendingToolStartedAt(toolCallId: string): number | undefined;
	isInitialized: boolean;
	viewingAgentSession: boolean;
	isViewingAgentSession(): boolean;
	startToolWaitingTimer(): void;
	stopToolWaitingTimerIfIdle(): void;
	restartThinkingTimer(): void;
	setWorkingMessageForActiveTools(): void;
	ensureToolExecutionComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent;
	syncToolExecutionTrackingForHiddenMainEvent(event: AgentSessionEvent): void;
	updateEditorBorderColor(): void;
	cancelPartialUpdateRender(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	renderSessionItems: RenderSessionItems;
};

type RenderSessionEntries = (
	this: RenderSessionContextThis,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		session: { retryAttempt: 0 },
		toolOutputExpanded: false,
		executingToolNames: new Map<string, string>(),
		executingToolStartedAt: new Map<string, number>(),
		completedToolTimings: new Map<string, { startedAt: number; finishedAt: number }>(),
		clearToolExecutionTrackingFor: (
			InteractiveMode.prototype as unknown as { clearToolExecutionTrackingFor(toolCallId: string): void }
		).clearToolExecutionTrackingFor,
		getPendingToolStartedAt: (
			InteractiveMode.prototype as unknown as { getPendingToolStartedAt(toolCallId: string): number | undefined }
		).getPendingToolStartedAt,
		isInitialized: true,
		viewingAgentSession: false,
		isViewingAgentSession() {
			return this.viewingAgentSession;
		},
		startToolWaitingTimer: vi.fn(),
		stopToolWaitingTimerIfIdle: vi.fn(),
		restartThinkingTimer: vi.fn(),
		setWorkingMessageForActiveTools: vi.fn(),
		ensureToolExecutionComponent(_toolName: string, toolCallId: string) {
			const component = this.pendingTools.get(toolCallId);
			if (!component) {
				throw new Error(`Missing pending tool component: ${toolCallId}`);
			}
			return component;
		},
		syncToolExecutionTrackingForHiddenMainEvent: (
			InteractiveMode.prototype as unknown as {
				syncToolExecutionTrackingForHiddenMainEvent(event: AgentSessionEvent): void;
			}
		).syncToolExecutionTrackingForHiddenMainEvent,
		updateEditorBorderColor: vi.fn(),
		cancelPartialUpdateRender: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		renderSessionItems: (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves elapsed time when a pending tool is rebuilt before completion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));
		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			args: { delayMs: 10_000 },
			startedAt: 1_000,
		});
		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		vi.setSystemTime(4_000);
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
			startedAt: 1_000,
			finishedAt: 4_000,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		const renderedChat = renderChat(fakeThis.chatContainer);
		expect(renderedChat).toContain("FINAL_RESULT");
		expect(renderedChat).toContain("Elapsed: 3s");
		vi.useRealTimers();
	});

	test("preserves elapsed time when a main tool starts while viewing a child session", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		fakeThis.viewingAgentSession = true;
		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			args: { delayMs: 10_000 },
			startedAt: 1_000,
		});

		fakeThis.viewingAgentSession = false;
		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));
		vi.setSystemTime(4_000);
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
			startedAt: 1_000,
			finishedAt: 4_000,
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("Elapsed: 3s");
		vi.useRealTimers();
	});

	test("preserves elapsed time when a main tool finishes while viewing a child session", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		fakeThis.viewingAgentSession = true;
		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			args: { delayMs: 10_000 },
			startedAt: 1_000,
		});
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
			startedAt: 1_000,
			finishedAt: 4_000,
		});

		fakeThis.viewingAgentSession = false;
		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("FINAL_RESULT")]),
		);

		expect(renderChat(fakeThis.chatContainer)).toContain("Elapsed: 3s");
		vi.useRealTimers();
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;

		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});
