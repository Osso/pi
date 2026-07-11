import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type AutocompleteProvider, CombinedAutocompleteProvider, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AutocompleteProviderFactory, ToolDefinition } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { AgentSelectionBannerComponent } from "../src/modes/interactive/components/agent-selection-banner.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(component: Component, width = 120): string {
	return component.render(width).join("\n");
}

class TestFocusableComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	private readonly label: string;
	private text = "";

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

async function flushTui(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
}

function normalizeRenderedOutput(component: Component, width = 220): string {
	return renderAll(component, width)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function hasHandleInput(component: Component): component is Component & { handleInput: (keyData: string) => void } {
	return "handleInput" in component && typeof component.handleInput === "function";
}

type ExtensionFixture = {
	path: string;
	sourceInfo?: SourceInfo;
};

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => {} });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.setToolsExpanded", () => {
	test("applies expansion state to the active header and chat entries", () => {
		const header = { setExpanded: vi.fn() };
		const loadedResourcesChild = { setExpanded: vi.fn() };
		const chatChild = { setExpanded: vi.fn() };
		const fakeThis: any = {
			toolOutputExpanded: false,
			customHeader: undefined,
			builtInHeader: header,
			loadedResourcesContainer: { children: [loadedResourcesChild] },
			chatContainer: { children: [chatChild] },
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setToolsExpanded.call(fakeThis, true);

		expect(fakeThis.toolOutputExpanded).toBe(true);
		expect(header.setExpanded).toHaveBeenCalledWith(true);
		expect(loadedResourcesChild.setExpanded).toHaveBeenCalledWith(true);
		expect(chatChild.setExpanded).toHaveBeenCalledWith(true);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

interface InteractiveModeKeyHandlerInternals {
	addMessageToChat(this: unknown, message: unknown, options?: { populateHistory?: boolean }): void;
	clearChildAgentView(this: unknown): void;
	createWorkingLoader(this: unknown): Component & { stop(): void };
	currentFooter(this: unknown): Component & { dispose?(): void };
	getUserMessageText(this: unknown, message: unknown): string;
	isViewingAgentSession(this: unknown): boolean;
	registerAgentSlotKeyHandlers(this: unknown): void;
	registerGlobalAgentSlotInputHandler(this: unknown): void;
	showAgentSwitcher(this: unknown): void;
	openChildAgentView(this: unknown, agent: unknown): boolean;
	renderInitialMessages(this: unknown): void;
	findReadableAgentLogPath(this: unknown, agent: unknown): string | undefined;
	readAgentLogPreview(this: unknown, logPath: string): string;
	readAgentLogPreviewUnchecked(this: unknown, logPath: string): string;
	reloadSelectedAgentTranscript(this: unknown): void;
	renderLiveAgentPlaceholder(this: unknown, agent: unknown, transcriptPath: string | undefined): void;
	renderSelectedAgentView(this: unknown): boolean;
	renderSessionContext(
		this: unknown,
		sessionContext: ReturnType<SessionManager["buildSessionContext"]>,
		options?: { sourceCwd?: string; updateFooter?: boolean; populateHistory?: boolean },
	): void;
	renderSessionItems(
		this: unknown,
		messages: unknown[],
		options?: { sourceCwd?: string; updateFooter?: boolean; populateHistory?: boolean },
	): void;
	restorePreviousAgentSelection(this: unknown, agentId: string | undefined): void;
	selectAgentSlot(this: unknown, slotIndex: number): void;
	selectAgentView(this: unknown, agentId: string): boolean;
	selectAgentViewFromBridge(this: unknown, agentId: string): boolean;
	setWorkingVisible(this: unknown, visible: boolean): void;
	syncWorkingLoaderVisibility(this: unknown): void;
	isSelectedChildWorking(this: unknown): boolean;
	subscribeToMultiAgentStore(this: unknown): void;
	showInactiveAgentSelectionStatus(this: unknown, selected: unknown): void;
	showStatus(this: unknown, message: string): void;
	stopWorkingLoader(this: unknown): void;
	updateSelectedAgentBanner(this: unknown): void;
	updateSelectedAgentSelectionWidgets(this: unknown): void;
	watchSelectedAgentTranscript(this: unknown, transcriptPath: string): void;
	setDefaultExtensionFooter(this: unknown, factory: (() => Component & { dispose?(): void }) | undefined): void;
	setExtensionFooter(this: unknown, factory: (() => Component & { dispose?(): void }) | undefined): void;
	resetExtensionUI(this: unknown): void;
	cancelSelectedAgentTurn(this: unknown): boolean;
	cancelStreamingAndSubmitQueuedMessages(this: unknown): Promise<void>;
	setupKeyHandlers(this: unknown): void;
}

const interactiveModeKeyHandlers = InteractiveMode.prototype as unknown as InteractiveModeKeyHandlerInternals;

type TranscriptSwitchFixture = {
	childAgentId: string;
	cleanup: () => void;
	fakeThis: {
		addMessageToChat: typeof interactiveModeKeyHandlers.addMessageToChat;
		addRenderedMessageToEditorHistory: () => void;
		chatContainer: Container;
		childViewAgentId?: string;
		childViewSessionManager?: SessionManager;
		childViewTranscriptPath?: string;
		childViewTranscriptWatcher?: { close(): void } | null;
		clearChildAgentView: typeof interactiveModeKeyHandlers.clearChildAgentView;
		createWorkingLoader: ReturnType<typeof vi.fn>;
		footer: { invalidate: ReturnType<typeof vi.fn> };
		loadingAnimation: (Component & { stop(): void }) | undefined;
		getMarkdownThemeWithSettings: () => undefined;
		getRegisteredToolDefinition: (name: string) => ToolDefinition | undefined;
		getUserMessageText: typeof interactiveModeKeyHandlers.getUserMessageText;
		isViewingAgentSession: typeof interactiveModeKeyHandlers.isViewingAgentSession;
		multiAgentStore: MultiAgentStore;
		pendingTools: Map<string, unknown>;
		renderInitialMessages: typeof interactiveModeKeyHandlers.renderInitialMessages;
		renderProjectTrustWarningIfNeeded: () => void;
		openChildAgentView: typeof interactiveModeKeyHandlers.openChildAgentView;
		findReadableAgentLogPath: typeof interactiveModeKeyHandlers.findReadableAgentLogPath;
		readAgentLogPreview: typeof interactiveModeKeyHandlers.readAgentLogPreview;
		readAgentLogPreviewUnchecked: typeof interactiveModeKeyHandlers.readAgentLogPreviewUnchecked;
		reloadSelectedAgentTranscript: typeof interactiveModeKeyHandlers.reloadSelectedAgentTranscript;
		renderLiveAgentPlaceholder: typeof interactiveModeKeyHandlers.renderLiveAgentPlaceholder;
		renderSelectedAgentView: typeof interactiveModeKeyHandlers.renderSelectedAgentView;
		restorePreviousAgentSelection: typeof interactiveModeKeyHandlers.restorePreviousAgentSelection;
		renderSessionContext: typeof interactiveModeKeyHandlers.renderSessionContext;
		renderSessionItems: typeof interactiveModeKeyHandlers.renderSessionItems;
		selectAgentView: typeof interactiveModeKeyHandlers.selectAgentView;
		selectedAgentBanner: AgentSelectionBannerComponent;
		session: { isStreaming: boolean };
		sessionManager: SessionManager;
		setWorkingVisible: typeof interactiveModeKeyHandlers.setWorkingVisible;
		settingsManager: { getImageWidthCells: () => number; getShowImages: () => boolean };
		syncWorkingLoaderVisibility: typeof interactiveModeKeyHandlers.syncWorkingLoaderVisibility;
		showStatus: ReturnType<typeof vi.fn>;
		statusContainer: Container;
		stopWorkingLoader: typeof interactiveModeKeyHandlers.stopWorkingLoader;
		toolOutputExpanded: boolean;
		ui: { requestRender: ReturnType<typeof vi.fn> };
		workingVisible: boolean;
		updateEditorBorderColor: ReturnType<typeof vi.fn>;
		updateSelectedAgentBanner: typeof interactiveModeKeyHandlers.updateSelectedAgentBanner;
		updateSelectedAgentSelectionWidgets: typeof interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets;
		watchSelectedAgentTranscript: ReturnType<typeof vi.fn>;
	};
	store: MultiAgentStore;
};

function createTranscriptSwitchFixture(options: {
	childCwd?: string;
	withChildPath: boolean;
}): TranscriptSwitchFixture {
	const tmp = mkdtempSync(path.join(tmpdir(), "pi-transcript-switch-"));
	const parent = SessionManager.create("/repo", tmp);
	parent.appendMessage({ role: "user", content: "parent transcript only", timestamp: 1 });
	parent.appendMessage(fauxAssistantMessage("parent reply"));
	const child = SessionManager.create(options.childCwd ?? "/repo", tmp);
	child.appendMessage({ role: "user", content: "child transcript only", timestamp: 2 });
	child.appendMessage(fauxAssistantMessage("child reply"));
	const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
	const spawned = store.spawnAgent({
		agentType: "worker",
		cwd: "/repo",
		displayName: "Scout",
		lifecycle: "starting",
		permission: { narrowed: true, policy: "on-request" },
		transcript: {
			path: options.withChildPath ? child.getSessionFile() : undefined,
			sessionId: child.getSessionId(),
		},
	});
	const fakeThis = {
		addMessageToChat: interactiveModeKeyHandlers.addMessageToChat,
		addRenderedMessageToEditorHistory: () => {},
		chatContainer: new Container(),
		childViewAgentId: undefined,
		childViewSessionManager: undefined,
		childViewTranscriptPath: undefined,
		childViewTranscriptWatcher: null,
		clearChildAgentView: interactiveModeKeyHandlers.clearChildAgentView,
		createWorkingLoader: vi.fn(() => ({
			invalidate: () => {},
			render: () => ["Thinking..."],
			stop: vi.fn(),
		})),
		footer: { invalidate: vi.fn() },
		loadingAnimation: undefined,
		getMarkdownThemeWithSettings: () => undefined,
		getRegisteredToolDefinition: () => undefined,
		getUserMessageText: interactiveModeKeyHandlers.getUserMessageText,
		isViewingAgentSession: interactiveModeKeyHandlers.isViewingAgentSession,
		multiAgentStore: store,
		pendingTools: new Map<string, unknown>(),
		renderInitialMessages: interactiveModeKeyHandlers.renderInitialMessages,
		renderProjectTrustWarningIfNeeded: () => {},
		openChildAgentView: interactiveModeKeyHandlers.openChildAgentView,
		reloadSelectedAgentTranscript: interactiveModeKeyHandlers.reloadSelectedAgentTranscript,
		findReadableAgentLogPath: interactiveModeKeyHandlers.findReadableAgentLogPath,
		readAgentLogPreview: interactiveModeKeyHandlers.readAgentLogPreview,
		readAgentLogPreviewUnchecked: interactiveModeKeyHandlers.readAgentLogPreviewUnchecked,
		renderLiveAgentPlaceholder: interactiveModeKeyHandlers.renderLiveAgentPlaceholder,
		renderSelectedAgentView: interactiveModeKeyHandlers.renderSelectedAgentView,
		restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
		renderSessionContext: interactiveModeKeyHandlers.renderSessionContext,
		renderSessionItems: interactiveModeKeyHandlers.renderSessionItems,
		selectAgentView: interactiveModeKeyHandlers.selectAgentView,
		selectedAgentBanner: new AgentSelectionBannerComponent(store),
		session: { isStreaming: false },
		sessionManager: parent,
		setWorkingVisible: interactiveModeKeyHandlers.setWorkingVisible,
		settingsManager: { getImageWidthCells: () => 80, getShowImages: () => false },
		syncWorkingLoaderVisibility: interactiveModeKeyHandlers.syncWorkingLoaderVisibility,
		isSelectedChildWorking: interactiveModeKeyHandlers.isSelectedChildWorking,
		subscribeToMultiAgentStore: interactiveModeKeyHandlers.subscribeToMultiAgentStore,
		showStatus: vi.fn(),
		statusContainer: new Container(),
		stopWorkingLoader: interactiveModeKeyHandlers.stopWorkingLoader,
		toolOutputExpanded: false,
		ui: { requestRender: vi.fn() },
		workingVisible: true,
		updateEditorBorderColor: vi.fn(),
		updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
		updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
		watchSelectedAgentTranscript: vi.fn(),
	};
	return {
		childAgentId: spawned.agent.id,
		cleanup: () => rmSync(tmp, { force: true, recursive: true }),
		fakeThis,
		store,
	};
}

describe("InteractiveMode key handlers", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("/agents action opens selector when the multi-agent store has no child agents", () => {
		let renderedSelector: Component | undefined;
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const fakeThis = {
			multiAgentStore: store,
			selectAgentView: vi.fn(),
			showSelector: (create: (done: () => void) => { component: Component; focus: Component }) => {
				renderedSelector = create(() => {}).component;
			},
			showStatus: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		interactiveModeKeyHandlers.showAgentSwitcher.call(fakeThis);

		expect(fakeThis.showStatus).not.toHaveBeenCalledWith("No agents to select");
		if (!(renderedSelector instanceof Container)) {
			throw new Error("Expected /agents to open a container selector");
		}
		expect(normalizeRenderedOutput(renderedSelector)).toContain("Main thread");
	});

	test("selected-agent banner is hidden before agents or selected view exist", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const banner = new AgentSelectionBannerComponent(store);

		expect(normalizeRenderedOutput(banner)).toBe("");
	});

	test("selected-agent banner is hidden when agents exist without an active selection", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Scout",
			permission: { narrowed: true, policy: "on-request" },
		});
		const banner = new AgentSelectionBannerComponent(store);

		expect(normalizeRenderedOutput(banner)).toBe("");
	});

	test("selected-agent banner returns to main thread when selected view becomes inactive", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		store.selectAgentView(spawned.agent.id);

		expect(store.transitionAgent(spawned.agent.id, running.agent.revision, "completed").ok).toBe(true);
		const banner = new AgentSelectionBannerComponent(store);

		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(normalizeRenderedOutput(banner)).toBe("");
	});

	test("/agents selection updates the visible selected-agent banner", () => {
		let renderedSelector: (Component & { handleInput: (keyData: string) => void }) | undefined;
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const banner = new AgentSelectionBannerComponent(store);
		const fakeThis = {
			multiAgentStore: store,
			selectedAgentBanner: banner,
			footer: { invalidate: vi.fn() },
			openChildAgentView: vi.fn(() => true),
			restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
			selectAgentView: interactiveModeKeyHandlers.selectAgentView,
			showSelector: (create: (done: () => void) => { component: Component; focus: Component }) => {
				const selector = create(() => {}).component;
				if (hasHandleInput(selector)) {
					renderedSelector = selector;
				}
			},
			showStatus: vi.fn(),
			syncWorkingLoaderVisibility: vi.fn(),
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			ui: { requestRender: vi.fn() },
		};

		interactiveModeKeyHandlers.showAgentSwitcher.call(fakeThis);
		if (!renderedSelector) {
			throw new Error("Expected /agents to open a selector");
		}
		renderedSelector.handleInput("\u001b[B");
		renderedSelector.handleInput("\r");

		expect(store.getSelectedAgentId()).toBe(spawned.agent.id);
		expect(normalizeRenderedOutput(banner)).toBe(`Agent ${spawned.agent.id}: Scout (starting)`);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(`Agent selected: ${spawned.agent.id}`);
	});

	test("escape while viewing an active child agent cancels that agent", () => {
		const actions = new Map<string, () => void>();
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Scout",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected running transition");
		}
		store.selectAgentView(spawned.agent.id);
		const abortChild = vi.fn();
		store.registerAgentAbortHandler(spawned.agent.id, abortChild);
		const fakeThis = {
			defaultEditor: {
				onEscape: undefined as (() => void) | undefined,
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			editor: { getText: () => "", setText: vi.fn() },
			multiAgentStore: store,
			selectedAgentBanner: new AgentSelectionBannerComponent(store),
			footer: { invalidate: vi.fn() },
			registerAgentSlotKeyHandlers: interactiveModeKeyHandlers.registerAgentSlotKeyHandlers,
			registerGlobalAgentSlotInputHandler: vi.fn(),
			session: { abortBash: vi.fn(), isBashRunning: false, isStreaming: false },
			settingsManager: { getDoubleEscapeAction: () => "none" },
			ui: { onDebug: undefined, requestRender: vi.fn() },
			cancelSelectedAgentTurn: interactiveModeKeyHandlers.cancelSelectedAgentTurn,
			cancelStreamingAndSubmitQueuedMessages: vi.fn(),
			cycleModel: vi.fn(),
			cycleThinkingLevel: vi.fn(),
			handleClearCommand: vi.fn(),
			handleCtrlC: vi.fn(),
			handleCtrlD: vi.fn(),
			handleCtrlZ: vi.fn(),
			handleDebugCommand: vi.fn(),
			handleDequeue: vi.fn(),
			handleFollowUp: vi.fn(),
			handleClipboardImagePaste: vi.fn(),
			openExternalEditor: vi.fn(),
			restoreQueuedMessagesToEditor: vi.fn(),
			showModelSelector: vi.fn(),
			showSessionSelector: vi.fn(),
			showStatus: vi.fn(),
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
		};

		interactiveModeKeyHandlers.setupKeyHandlers.call(fakeThis);
		fakeThis.defaultEditor.onEscape?.();

		expect(abortChild).toHaveBeenCalledTimes(1);
		expect(store.getAgent(spawned.agent.id)?.lifecycle).toBe("aborted");
		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(fakeThis.cancelStreamingAndSubmitQueuedMessages).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
	});

	test("escape while streaming cancels and submits queued messages", () => {
		const actions = new Map<string, () => void>();
		const fakeThis = {
			defaultEditor: {
				onEscape: undefined as (() => void) | undefined,
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			editor: { getText: () => "", setText: vi.fn() },
			multiAgentStore: undefined,
			registerAgentSlotKeyHandlers: interactiveModeKeyHandlers.registerAgentSlotKeyHandlers,
			registerGlobalAgentSlotInputHandler: vi.fn(),
			session: { abortBash: vi.fn(), isBashRunning: false, isStreaming: true },
			settingsManager: { getDoubleEscapeAction: () => "none" },
			ui: { onDebug: undefined, requestRender: vi.fn() },
			cancelSelectedAgentTurn: vi.fn(() => false),
			cancelStreamingAndSubmitQueuedMessages: vi.fn(),
			cycleModel: vi.fn(),
			cycleThinkingLevel: vi.fn(),
			handleClearCommand: vi.fn(),
			handleCtrlC: vi.fn(),
			handleCtrlD: vi.fn(),
			handleCtrlZ: vi.fn(),
			handleDebugCommand: vi.fn(),
			handleDequeue: vi.fn(),
			handleFollowUp: vi.fn(),
			handleClipboardImagePaste: vi.fn(),
			openExternalEditor: vi.fn(),
			restoreQueuedMessagesToEditor: vi.fn(),
			showModelSelector: vi.fn(),
			showSessionSelector: vi.fn(),
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		interactiveModeKeyHandlers.setupKeyHandlers.call(fakeThis);
		fakeThis.defaultEditor.onEscape?.();

		expect(fakeThis.cancelStreamingAndSubmitQueuedMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
	});

	test("escape cancellation submits queued and current text without waiting for abort teardown", async () => {
		let resolveAbort: (() => void) | undefined;
		const abortPromise = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const releasePendingInput = vi.fn();
		const fakeThis = {
			clearAllQueues: vi.fn(() => ({ steering: ["queued steering"], followUp: ["queued follow-up"] })),
			editor: { getText: () => "current draft", setText: vi.fn() },
			onInputCallback: undefined,
			pendingUserInputs: [] as string[],
			session: {
				abort: vi.fn(() => abortPromise),
				reserveExternalUserInput: vi.fn(() => releasePendingInput),
			},
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		};

		interactiveModeKeyHandlers.cancelStreamingAndSubmitQueuedMessages.call(fakeThis);
		await Promise.resolve();

		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.session.abort).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.reserveExternalUserInput).toHaveBeenCalledTimes(1);
		expect(fakeThis.pendingUserInputs).toEqual(["queued steering\n\nqueued follow-up\n\ncurrent draft"]);
		expect(releasePendingInput).not.toHaveBeenCalled();

		resolveAbort?.();
		await abortPromise;
		await Promise.resolve();
		expect(releasePendingInput).toHaveBeenCalledTimes(1);
	});

	test("opens the agent switcher when the agent select action fires", () => {
		const actions = new Map<string, () => void>();
		const fakeThis = {
			defaultEditor: {
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			editor: { getText: () => "", setText: vi.fn() },
			multiAgentStore: undefined,
			registerAgentSlotKeyHandlers: interactiveModeKeyHandlers.registerAgentSlotKeyHandlers,
			registerGlobalAgentSlotInputHandler: vi.fn(),
			session: { abortBash: vi.fn(), isBashRunning: false, isStreaming: false },
			settingsManager: { getDoubleEscapeAction: () => "none" },
			ui: { onDebug: undefined, requestRender: vi.fn() },
			cancelSelectedAgentTurn: vi.fn(() => false),
			cycleModel: vi.fn(),
			cycleThinkingLevel: vi.fn(),
			handleClearCommand: vi.fn(),
			handleCtrlC: vi.fn(),
			handleCtrlD: vi.fn(),
			handleCtrlZ: vi.fn(),
			handleDebugCommand: vi.fn(),
			handleDequeue: vi.fn(),
			handleFollowUp: vi.fn(),
			handleClipboardImagePaste: vi.fn(),
			openExternalEditor: vi.fn(),
			restoreQueuedMessagesToEditor: vi.fn(),
			showAgentSwitcher: vi.fn(),
			showModelSelector: vi.fn(),
			showSessionSelector: vi.fn(),
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		interactiveModeKeyHandlers.setupKeyHandlers.call(fakeThis);
		actions.get("app.agent.select")?.();

		expect(fakeThis.showAgentSwitcher).toHaveBeenCalledTimes(1);
	});

	test("switches selected agent when an agent slot action fires", () => {
		const actions = new Map<string, () => void>();
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const first = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 1, pinned: true },
		});
		const second = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Second",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 2, pinned: true },
		});
		const third = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Third",
			permission: { narrowed: true, policy: "on-request" },
			slot: { index: 3, pinned: true },
		});
		store.selectActiveAgentTargetWithStatus(first.agent.id);
		const banner = new AgentSelectionBannerComponent(store);
		const fakeThis = {
			defaultEditor: {
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			editor: { getText: () => "", setText: vi.fn() },
			multiAgentStore: store,
			selectedAgentBanner: banner,
			footer: { invalidate: vi.fn() },
			openChildAgentView: vi.fn(() => true),
			syncWorkingLoaderVisibility: vi.fn(),
			registerAgentSlotKeyHandlers: interactiveModeKeyHandlers.registerAgentSlotKeyHandlers,
			registerGlobalAgentSlotInputHandler: vi.fn(),
			restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
			selectAgentSlot: interactiveModeKeyHandlers.selectAgentSlot,
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			session: { abortBash: vi.fn(), isBashRunning: false, isStreaming: false },
			settingsManager: { getDoubleEscapeAction: () => "none" },
			ui: { onDebug: undefined, requestRender: vi.fn() },
			cancelSelectedAgentTurn: vi.fn(() => false),
			cycleModel: vi.fn(),
			cycleThinkingLevel: vi.fn(),
			handleClearCommand: vi.fn(),
			handleCtrlC: vi.fn(),
			handleCtrlD: vi.fn(),
			handleCtrlZ: vi.fn(),
			handleDebugCommand: vi.fn(),
			handleDequeue: vi.fn(),
			handleFollowUp: vi.fn(),
			handleClipboardImagePaste: vi.fn(),
			openExternalEditor: vi.fn(),
			restoreQueuedMessagesToEditor: vi.fn(),
			showModelSelector: vi.fn(),
			showSessionSelector: vi.fn(),
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			updateEditorBorderColor: vi.fn(),
		};

		interactiveModeKeyHandlers.setupKeyHandlers.call(fakeThis);
		actions.get("app.agent.slot2")?.();
		expect(store.getSelectedAgentId()).toBe(first.agent.id);

		actions.get("app.agent.slot3")?.();
		expect(store.getSelectedAgentId()).toBe(second.agent.id);

		actions.get("app.agent.slot4")?.();
		expect(store.getSelectedAgentId()).toBe(third.agent.id);
		expect(normalizeRenderedOutput(banner)).toBe(`Agent ${third.agent.id}: Third (queued)`);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(3);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(3);
	});

	test("selects an agent view without mutating lifecycle", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const fakeThis = {
			multiAgentStore: store,
			selectedAgentBanner: new AgentSelectionBannerComponent(store),
			footer: { invalidate: vi.fn() },
			openChildAgentView: vi.fn(() => true),
			restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
			syncWorkingLoaderVisibility: vi.fn(),
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			ui: { requestRender: vi.fn() },
		};

		const selected = interactiveModeKeyHandlers.selectAgentView.call(fakeThis, spawned.agent.id);

		expect(selected).toBe(true);
		expect(store.getSelectedAgentId()).toBe(spawned.agent.id);
		expect(store.getAgent(spawned.agent.id)).toMatchObject({
			id: spawned.agent.id,
			lifecycle: "starting",
			revision: spawned.agent.revision,
		});
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
	});

	test("selecting an active child view renders the child transcript instead of the parent transcript", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: true });
		try {
			const selected = interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId);

			expect(selected).toBe(true);
			expect(fixture.store.getSelectedAgentId()).toBe(fixture.childAgentId);
			expect(fixture.fakeThis.childViewSessionManager?.getSessionId()).toBe(
				fixture.store.getAgent(fixture.childAgentId)?.transcript?.sessionId,
			);
			const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
			expect(output).toContain("child transcript only");
			expect(output).not.toContain("parent transcript only");
		} finally {
			fixture.cleanup();
		}
	});

	test("reloads the selected child transcript when new messages are appended", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: true });
		try {
			expect(interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId)).toBe(true);
			const transcriptPath = fixture.store.getAgent(fixture.childAgentId)?.transcript?.path;
			if (!transcriptPath) {
				throw new Error("expected child transcript path");
			}

			SessionManager.open(transcriptPath).appendMessage(fauxAssistantMessage("new child reply"));
			interactiveModeKeyHandlers.reloadSelectedAgentTranscript.call(fixture.fakeThis);

			const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
			expect(output).toContain("child reply");
			expect(output).toContain("new child reply");
			expect(fixture.fakeThis.ui.requestRender).toHaveBeenCalled();
		} finally {
			fixture.cleanup();
		}
	});

	test("child transcript tool components render with the child session cwd", () => {
		const fixture = createTranscriptSwitchFixture({ childCwd: "/child-repo", withChildPath: true });
		let renderedToolCwd: string | undefined;
		const cwdProbeTool: ToolDefinition = {
			name: "cwd_probe",
			label: "cwd probe",
			description: "Render cwd probe",
			parameters: {},
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
			renderCall: (_args, _theme, context) => {
				renderedToolCwd = context.cwd;
				return new Text("cwd probe", 0, 0);
			},
		};
		fixture.fakeThis.getRegisteredToolDefinition = (name) => (name === "cwd_probe" ? cwdProbeTool : undefined);
		const transcriptPath = fixture.store.getAgent(fixture.childAgentId)?.transcript?.path;
		if (!transcriptPath) {
			throw new Error("expected child transcript path");
		}
		SessionManager.open(transcriptPath).appendMessage(
			fauxAssistantMessage(fauxToolCall("cwd_probe", {}), { stopReason: "toolUse" }),
		);
		try {
			const selected = interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId);

			expect(selected).toBe(true);
			expect(renderedToolCwd).toBe("/child-repo");
		} finally {
			fixture.cleanup();
		}
	});

	test("shows a clean child working loader while viewing a running child", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: true });
		const mainLoaderStop = vi.fn();
		const mainLoader: Component & { stop(): void } = {
			invalidate: () => {},
			render: () => ["main working"],
			stop: mainLoaderStop,
		};
		const childLoader: Component & { stop(): void } = {
			invalidate: () => {},
			render: () => ["Thinking..."],
			stop: vi.fn(),
		};
		fixture.fakeThis.createWorkingLoader.mockReturnValue(childLoader);
		const otherStatus = new Text("other status", 0, 0);
		fixture.fakeThis.loadingAnimation = mainLoader;
		fixture.fakeThis.statusContainer.addChild(mainLoader);
		fixture.fakeThis.session.isStreaming = true;
		const running = fixture.store.transitionAgent(
			fixture.childAgentId,
			fixture.store.getAgent(fixture.childAgentId)!.revision,
			"running",
		);
		expect(running.ok).toBe(true);
		fixture.fakeThis.statusContainer.addChild(otherStatus);
		try {
			expect(interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId)).toBe(true);

			expect(mainLoaderStop).toHaveBeenCalledTimes(1);
			expect(fixture.fakeThis.loadingAnimation).toBe(childLoader);
			expect(fixture.fakeThis.statusContainer.children).toEqual([otherStatus, childLoader]);
			expect(fixture.fakeThis.session.isStreaming).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	test.each(["completed", "failed", "aborted"] as const)(
		"restores the parent view and main loader when the selected child reaches %s",
		(terminalLifecycle) => {
			const fixture = createTranscriptSwitchFixture({ withChildPath: true });
			const mainLoader: Component & { stop(): void } = {
				invalidate: () => {},
				render: () => ["main working"],
				stop: vi.fn(),
			};
			const childLoader: Component & { stop(): void } = {
				invalidate: () => {},
				render: () => ["Thinking..."],
				stop: vi.fn(),
			};
			const childWatcher = { close: vi.fn() };
			fixture.fakeThis.createWorkingLoader.mockReturnValueOnce(childLoader).mockReturnValue(mainLoader);
			fixture.fakeThis.loadingAnimation = mainLoader;
			fixture.fakeThis.statusContainer.addChild(mainLoader);
			fixture.fakeThis.session.isStreaming = true;
			try {
				interactiveModeKeyHandlers.subscribeToMultiAgentStore.call(fixture.fakeThis);
				const child = fixture.store.getAgent(fixture.childAgentId)!;
				const running = fixture.store.transitionAgent(fixture.childAgentId, child.revision, "running");
				expect(running.ok).toBe(true);
				if (!running.ok) {
					throw new Error("expected running transition");
				}
				expect(interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId)).toBe(true);
				fixture.fakeThis.childViewTranscriptWatcher = childWatcher;

				const terminal = fixture.store.transitionAgent(
					fixture.childAgentId,
					running.agent.revision,
					terminalLifecycle,
				);
				expect(terminal.ok).toBe(true);
				expect(childLoader.stop).toHaveBeenCalledTimes(1);
				expect(fixture.fakeThis.loadingAnimation).toBe(mainLoader);
				expect(fixture.fakeThis.statusContainer.children).not.toContain(childLoader);
				expect(fixture.fakeThis.statusContainer.children).toContain(mainLoader);
				expect(fixture.store.getSelectedAgentId()).toBeUndefined();
				expect(fixture.fakeThis.childViewAgentId).toBeUndefined();
				expect(fixture.fakeThis.childViewTranscriptPath).toBeUndefined();
				expect(fixture.fakeThis.childViewSessionManager).toBeUndefined();
				expect(childWatcher.close).toHaveBeenCalledTimes(1);
				const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
				expect(output).toContain("parent transcript only");
				expect(output).not.toContain("child transcript only");
			} finally {
				fixture.cleanup();
			}
		},
	);

	test("selecting main restores the parent transcript and active main working loader", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: true });
		const mainLoader: Component & { stop(): void } = {
			invalidate: () => {},
			render: () => ["main working"],
			stop: vi.fn(),
		};
		fixture.fakeThis.session.isStreaming = true;
		fixture.fakeThis.createWorkingLoader.mockReturnValue(mainLoader);
		try {
			expect(interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId)).toBe(true);

			expect(interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, "main")).toBe(true);

			expect(fixture.store.getSelectedAgentId()).toBeUndefined();
			expect(fixture.fakeThis.childViewSessionManager).toBeUndefined();
			expect(fixture.fakeThis.loadingAnimation).toBe(mainLoader);
			expect(fixture.fakeThis.statusContainer.children).toContain(mainLoader);
			const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
			expect(output).toContain("parent transcript only");
			expect(output).not.toContain("child transcript only");
		} finally {
			fixture.cleanup();
		}
	});

	test("bridge selection reports success when returning to main thread", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: true });
		try {
			expect(interactiveModeKeyHandlers.selectAgentViewFromBridge.call(fixture.fakeThis, fixture.childAgentId)).toBe(
				true,
			);

			expect(interactiveModeKeyHandlers.selectAgentViewFromBridge.call(fixture.fakeThis, "main")).toBe(true);

			expect(fixture.store.getSelectedAgentId()).toBeUndefined();
			expect(fixture.fakeThis.childViewSessionManager).toBeUndefined();
			const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
			expect(output).toContain("parent transcript only");
			expect(output).not.toContain("child transcript only");
		} finally {
			fixture.cleanup();
		}
	});

	test("selecting an active child without a transcript path renders a live placeholder", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: false });
		try {
			fixture.fakeThis.chatContainer.addChild({ invalidate: () => {}, render: () => ["parent transcript only"] });

			const selected = interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId);

			expect(selected).toBe(true);
			expect(fixture.store.getSelectedAgentId()).toBe(fixture.childAgentId);
			expect(fixture.fakeThis.childViewSessionManager).toBeUndefined();
			const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
			expect(output).toContain("Viewing live agent: Scout");
			expect(output).toContain("Transcript file has not been assigned yet.");
			expect(output).not.toContain("parent transcript only");
		} finally {
			fixture.cleanup();
		}
	});

	test("selecting an active child without a transcript path renders its log artifact", () => {
		const fixture = createTranscriptSwitchFixture({ withChildPath: false });
		const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-log-view-"));
		try {
			const logPath = path.join(tmp, "agent.log");
			writeFileSync(logPath, "live log output", "utf8");
			fixture.store.recordArtifact({
				agentId: fixture.childAgentId,
				kind: "log",
				path: logPath,
				title: "Pyrun output",
			});

			const selected = interactiveModeKeyHandlers.selectAgentView.call(fixture.fakeThis, fixture.childAgentId);

			expect(selected).toBe(true);
			const output = normalizeRenderedOutput(fixture.fakeThis.chatContainer);
			expect(output).toContain("Viewing live agent: Scout");
			expect(output).toContain("Log: ");
			expect(output).toContain("agent.log");
			expect(output).toContain("live log output");
		} finally {
			rmSync(tmp, { force: true, recursive: true });
			fixture.cleanup();
		}
	});

	test("selecting an active child with an unwritten transcript file renders a live placeholder", () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "pi-transcript-rollback-"));
		try {
			const parent = SessionManager.create("/repo", tmp);
			parent.appendMessage({ role: "user", content: "parent transcript only", timestamp: 1 });
			const previousSession = SessionManager.create("/repo", tmp);
			previousSession.appendMessage({ role: "user", content: "previous completed transcript", timestamp: 2 });
			const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
			const previous = store.spawnAgent({
				agentType: "worker",
				cwd: "/repo",
				displayName: "Previous",
				lifecycle: "starting",
				permission: { narrowed: true, policy: "on-request" },
				transcript: { path: previousSession.getSessionFile(), sessionId: previousSession.getSessionId() },
			});
			const previousRunning = store.transitionAgent(previous.agent.id, previous.agent.revision, "running");
			expect(previousRunning.ok).toBe(true);
			if (!previousRunning.ok) {
				throw new Error("expected previous running transition");
			}
			expect(store.transitionAgent(previous.agent.id, previousRunning.agent.revision, "completed").ok).toBe(true);
			const next = store.spawnAgent({
				agentType: "worker",
				cwd: "/repo",
				displayName: "Next",
				lifecycle: "starting",
				permission: { narrowed: true, policy: "on-request" },
				transcript: { path: path.join(tmp, "missing.jsonl"), sessionId: "missing-session" },
			});
			store.selectAgentView(previous.agent.id);
			const fakeThis = {
				addMessageToChat: interactiveModeKeyHandlers.addMessageToChat,
				addRenderedMessageToEditorHistory: () => {},
				chatContainer: new Container(),
				childViewAgentId: previous.agent.id,
				childViewSessionManager: previousSession,
				childViewTranscriptPath: previousSession.getSessionFile(),
				clearChildAgentView: interactiveModeKeyHandlers.clearChildAgentView,
				footer: { invalidate: vi.fn() },
				getMarkdownThemeWithSettings: () => undefined,
				getRegisteredToolDefinition: () => undefined,
				getUserMessageText: interactiveModeKeyHandlers.getUserMessageText,
				multiAgentStore: store,
				openChildAgentView: interactiveModeKeyHandlers.openChildAgentView,
				pendingTools: new Map<string, unknown>(),
				renderInitialMessages: interactiveModeKeyHandlers.renderInitialMessages,
				renderProjectTrustWarningIfNeeded: () => {},
				findReadableAgentLogPath: interactiveModeKeyHandlers.findReadableAgentLogPath,
				readAgentLogPreview: interactiveModeKeyHandlers.readAgentLogPreview,
				readAgentLogPreviewUnchecked: interactiveModeKeyHandlers.readAgentLogPreviewUnchecked,
				renderLiveAgentPlaceholder: interactiveModeKeyHandlers.renderLiveAgentPlaceholder,
				renderSelectedAgentView: interactiveModeKeyHandlers.renderSelectedAgentView,
				renderSessionContext: interactiveModeKeyHandlers.renderSessionContext,
				renderSessionItems: interactiveModeKeyHandlers.renderSessionItems,
				restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
				selectedAgentBanner: new AgentSelectionBannerComponent(store),
				sessionManager: parent,
				settingsManager: { getImageWidthCells: () => 80, getShowImages: () => false },
				showStatus: vi.fn(),
				stopWorkingLoader: vi.fn(),
				syncWorkingLoaderVisibility: vi.fn(),
				toolOutputExpanded: false,
				ui: { requestRender: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
				updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
				watchSelectedAgentTranscript: vi.fn(),
			};
			interactiveModeKeyHandlers.renderSelectedAgentView.call(fakeThis);

			const selected = interactiveModeKeyHandlers.selectAgentView.call(fakeThis, next.agent.id);

			expect(selected).toBe(true);
			expect(store.getSelectedAgentId()).toBe(next.agent.id);
			const output = normalizeRenderedOutput(fakeThis.chatContainer);
			expect(output).toContain("Viewing live agent: Next");
			expect(output).toContain("Transcript file has not been written yet:");
			expect(output).not.toContain("previous completed transcript");
		} finally {
			rmSync(tmp, { force: true, recursive: true });
		}
	});

	test("rejects inactive agent view selection without changing the current agent", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const active = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Active",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const completed = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Done",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = store.transitionAgent(completed.agent.id, completed.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		expect(store.transitionAgent(completed.agent.id, running.agent.revision, "completed").ok).toBe(true);
		store.selectActiveAgentTargetWithStatus(active.agent.id);
		const fakeThis = {
			multiAgentStore: store,
			selectedAgentBanner: new AgentSelectionBannerComponent(store),
			footer: { invalidate: vi.fn() },
			showInactiveAgentSelectionStatus: interactiveModeKeyHandlers.showInactiveAgentSelectionStatus,
			showStatus: vi.fn(),
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			ui: { requestRender: vi.fn() },
		};

		const selected = interactiveModeKeyHandlers.selectAgentView.call(fakeThis, completed.agent.id);

		expect(selected).toBe(false);
		expect(store.getSelectedAgentId()).toBe(active.agent.id);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(`Agent is not active: Done (completed)`);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
	});

	test("switches to main thread from slot 1 before focused components receive input", () => {
		const listeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const first = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectActiveAgentTargetWithStatus(first.agent.id);
		const fakeThis = {
			chatContainer: { clear: vi.fn() },
			clearChildAgentView: vi.fn(),
			keybindings: { matches: (data: string, action: string) => action === "app.agent.slot1" && data === "\x1b1" },
			multiAgentStore: store,
			selectedAgentBanner: new AgentSelectionBannerComponent(store),
			footer: { invalidate: vi.fn() },
			openChildAgentView: vi.fn(() => true),
			renderInitialMessages: vi.fn(),
			restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
			selectAgentSlot: interactiveModeKeyHandlers.selectAgentSlot,
			selectAgentView: interactiveModeKeyHandlers.selectAgentView,
			showInactiveAgentSelectionStatus: interactiveModeKeyHandlers.showInactiveAgentSelectionStatus,
			syncWorkingLoaderVisibility: vi.fn(),
			showStatus: vi.fn(),
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			ui: {
				addInputListener: (listener: (data: string) => { consume?: boolean } | undefined) => {
					listeners.push(listener);
					return () => {};
				},
				requestRender: vi.fn(),
			},
		};

		interactiveModeKeyHandlers.registerGlobalAgentSlotInputHandler.call(fakeThis);
		const result = listeners[0]?.("\x1b1");

		expect(result).toEqual({ consume: true });
		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
	});

	test("slot 2 skips terminal agents before the first active agent view", () => {
		const actions = new Map<string, () => void>();
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const completed = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Completed",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = store.transitionAgent(completed.agent.id, completed.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected run to succeed");
		}
		expect(store.transitionAgent(completed.agent.id, running.agent.revision, "completed").ok).toBe(true);
		const active = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Active",
			permission: { narrowed: true, policy: "on-request" },
		});
		const fakeThis = {
			defaultEditor: {
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			multiAgentStore: store,
			selectedAgentBanner: new AgentSelectionBannerComponent(store),
			footer: { invalidate: vi.fn() },
			openChildAgentView: vi.fn(() => true),
			registerAgentSlotKeyHandlers: interactiveModeKeyHandlers.registerAgentSlotKeyHandlers,
			restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
			selectAgentSlot: interactiveModeKeyHandlers.selectAgentSlot,
			showInactiveAgentSelectionStatus: interactiveModeKeyHandlers.showInactiveAgentSelectionStatus,
			showStatus: vi.fn(),
			syncWorkingLoaderVisibility: vi.fn(),
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			ui: { requestRender: vi.fn() },
		};

		interactiveModeKeyHandlers.registerAgentSlotKeyHandlers.call(fakeThis);
		actions.get("app.agent.slot2")?.();

		expect(store.getSelectedAgentId()).toBe(active.agent.id);
		expect(fakeThis.openChildAgentView).toHaveBeenCalledWith(expect.objectContaining({ id: active.agent.id }));
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
	});

	test("slot 2 switches to the first active agent view when agents are not pinned to slots", () => {
		const actions = new Map<string, () => void>();
		const store = new MultiAgentStore({ now: () => "2026-06-27T00:00:00.000Z" });
		const first = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "First",
			permission: { narrowed: true, policy: "on-request" },
		});
		const second = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Second",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectActiveAgentTargetWithStatus(second.agent.id);
		const fakeThis = {
			defaultEditor: {
				onAction: (action: string, handler: () => void) => actions.set(action, handler),
			},
			multiAgentStore: store,
			selectedAgentBanner: new AgentSelectionBannerComponent(store),
			footer: { invalidate: vi.fn() },
			openChildAgentView: vi.fn(() => true),
			registerAgentSlotKeyHandlers: interactiveModeKeyHandlers.registerAgentSlotKeyHandlers,
			restorePreviousAgentSelection: interactiveModeKeyHandlers.restorePreviousAgentSelection,
			selectAgentSlot: interactiveModeKeyHandlers.selectAgentSlot,
			showInactiveAgentSelectionStatus: interactiveModeKeyHandlers.showInactiveAgentSelectionStatus,
			showStatus: vi.fn(),
			syncWorkingLoaderVisibility: vi.fn(),
			updateSelectedAgentBanner: interactiveModeKeyHandlers.updateSelectedAgentBanner,
			updateSelectedAgentSelectionWidgets: interactiveModeKeyHandlers.updateSelectedAgentSelectionWidgets,
			ui: { requestRender: vi.fn() },
		};

		interactiveModeKeyHandlers.registerAgentSlotKeyHandlers.call(fakeThis);
		actions.get("app.agent.slot2")?.();

		expect(store.getSelectedAgentId()).toBe(first.agent.id);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
	});
});

function createResetExtensionUIFixture(isViewingAgentSession: boolean) {
	const setMessage = vi.fn();
	const fakeThis = {
		autocompleteProviderWrappers: [],
		clearExtensionTerminalInputListeners: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		defaultEditor: {},
		defaultWorkingMessage: "Thinking...",
		extensionEditor: undefined,
		extensionInput: undefined,
		extensionSelector: undefined,
		footer: { invalidate: vi.fn() },
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		hideExtensionEditor: vi.fn(),
		hideExtensionInput: vi.fn(),
		hideExtensionSelector: vi.fn(),
		isViewingAgentSession: () => isViewingAgentSession,
		loadingAnimation: { setMessage },
		setCustomEditorComponent: vi.fn(),
		setDefaultExtensionFooter: vi.fn(),
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		ui: { hideOverlay: vi.fn() },
		updateTerminalTitle: vi.fn(),
		workingVisible: false,
	};
	return { fakeThis, setMessage };
}

describe("InteractiveMode footer ownership", () => {
	test("custom footers override default footers and clearing custom restores default", () => {
		const added: Component[] = [];
		const removed: Component[] = [];
		const builtIn = { invalidate() {}, render: () => ["built-in"] };
		const defaultFooter = { invalidate() {}, render: () => ["default"] };
		const customFooter = { invalidate() {}, render: () => ["custom"] };
		const fakeThis = {
			currentFooter: interactiveModeKeyHandlers.currentFooter,
			customFooter: undefined,
			defaultExtensionFooter: undefined,
			footer: builtIn,
			footerDataProvider: {},
			ui: {
				addChild: (component: Component) => added.push(component),
				removeChild: (component: Component) => removed.push(component),
				requestRender: vi.fn(),
			},
		};

		interactiveModeKeyHandlers.setDefaultExtensionFooter.call(fakeThis, () => defaultFooter);
		interactiveModeKeyHandlers.setExtensionFooter.call(fakeThis, () => customFooter);
		interactiveModeKeyHandlers.setExtensionFooter.call(fakeThis, undefined);

		expect(removed).toEqual([builtIn, defaultFooter, customFooter]);
		expect(added).toEqual([defaultFooter, customFooter, defaultFooter]);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(3);
	});

	test("reset disposes default extension footer before session invalidation", () => {
		const added: Component[] = [];
		const removed: Component[] = [];
		const builtIn = { invalidate: vi.fn(), render: () => ["built-in"] };
		const defaultFooter = { dispose: vi.fn(), invalidate() {}, render: () => ["default"] };
		const fakeThis = {
			autocompleteProviderWrappers: [],
			clearExtensionTerminalInputListeners: vi.fn(),
			clearExtensionWidgets: vi.fn(),
			currentFooter: interactiveModeKeyHandlers.currentFooter,
			customFooter: undefined,
			defaultEditor: {},
			defaultExtensionFooter: defaultFooter,
			extensionEditor: undefined,
			extensionInput: undefined,
			extensionSelector: undefined,
			footer: builtIn,
			footerDataProvider: { clearExtensionStatuses: vi.fn() },
			hideExtensionEditor: vi.fn(),
			hideExtensionInput: vi.fn(),
			hideExtensionSelector: vi.fn(),
			loadingAnimation: undefined,
			setCustomEditorComponent: vi.fn(),
			setDefaultExtensionFooter: interactiveModeKeyHandlers.setDefaultExtensionFooter,
			setExtensionFooter: interactiveModeKeyHandlers.setExtensionFooter,
			setExtensionHeader: vi.fn(),
			setHiddenThinkingLabel: vi.fn(),
			setWorkingIndicator: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			ui: {
				addChild: (component: Component) => added.push(component),
				hideOverlay: vi.fn(),
				removeChild: (component: Component) => removed.push(component),
				requestRender: vi.fn(),
			},
			updateTerminalTitle: vi.fn(),
			workingVisible: true,
		};

		interactiveModeKeyHandlers.resetExtensionUI.call(fakeThis);

		expect(defaultFooter.dispose).toHaveBeenCalledTimes(1);
		expect(fakeThis.defaultExtensionFooter).toBeUndefined();
		expect(interactiveModeKeyHandlers.currentFooter.call(fakeThis)).toBe(builtIn);
	});

	test("reset keeps the main working loader interrupt label", () => {
		const { fakeThis, setMessage } = createResetExtensionUIFixture(false);

		interactiveModeKeyHandlers.resetExtensionUI.call(fakeThis);

		expect(setMessage).toHaveBeenCalledWith(expect.stringMatching(/^Thinking\.\.\. .* to interrupt\)$/));
	});

	test("reset keeps a child working loader at the default thinking label", () => {
		const { fakeThis, setMessage } = createResetExtensionUIFixture(true);

		interactiveModeKeyHandlers.resetExtensionUI.call(fakeThis);

		expect(setMessage).toHaveBeenCalledWith("Thinking...");
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => {
					fakeThis.ui.requestRender();
					return { success: true };
				}),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("light");
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			themeController: {
				setThemeInstance: vi.fn(() => ({ success: true })),
				setThemeName: vi.fn(() => ({ success: false, error: "Theme not found" })),
			},
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(fakeThis.themeController.setThemeName).toHaveBeenCalledWith("__missing_theme__");
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showExtensionCustom", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("overlay custom UI reclaims input after non-overlay custom UI closes", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const ui = new TUI(terminal);
		const editorContainer = new Container();
		const editor = new TestFocusableComponent("EDITOR");
		const palette = new TestFocusableComponent("PALETTE");
		const overlay = new TestFocusableComponent("OVERLAY");
		const replacement = new TestFocusableComponent("REPLACEMENT");
		let closeOverlay: (value: string) => void = () => {
			throw new Error("closeOverlay was not initialized");
		};
		let closeReplacement: (value: string) => void = () => {
			throw new Error("closeReplacement was not initialized");
		};
		const fakeThis = {
			editor,
			editorContainer,
			keybindings: {},
			ui,
		};
		const showExtensionCustom = <T>(
			factory: (tui: TUI, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			options?: { overlay?: boolean },
		): Promise<T> =>
			(InteractiveMode as any).prototype.showExtensionCustom.call(fakeThis, factory, options) as Promise<T>;

		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.addChild(palette);
		ui.setFocus(palette);
		ui.start();
		try {
			const overlayPromise = showExtensionCustom<string>(
				(_tui, _theme, _keybindings, done) => {
					closeOverlay = done;
					return overlay;
				},
				{ overlay: true },
			);
			await flushTui(ui, terminal);
			expect(overlay.focused).toBe(true);

			const replacementPromise = showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				closeReplacement = done;
				return replacement;
			});
			await flushTui(ui, terminal);
			expect(replacement.focused).toBe(true);

			closeReplacement("done");
			await replacementPromise;
			await flushTui(ui, terminal);
			terminal.sendInput("x");
			await flushTui(ui, terminal);

			expect(overlay.inputs).toEqual(["x"]);
			expect(editor.inputs).toEqual([]);
			expect(overlay.focused).toBe(true);

			closeOverlay("closed");
			await overlayPromise;
		} finally {
			ui.stop();
		}
	});
});

describe("InteractiveMode.createExtensionUIContext addAutocompleteProvider", () => {
	test("stores wrapper factories and rebuilds autocomplete immediately", () => {
		const wrapper: AutocompleteProviderFactory = (current) => current;
		const fakeThis = {
			autocompleteProviderWrappers: [] as AutocompleteProviderFactory[],
			setupAutocompleteProvider: vi.fn(),
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		uiContext.addAutocompleteProvider(wrapper);

		expect(fakeThis.autocompleteProviderWrappers).toEqual([wrapper]);
		expect(fakeThis.setupAutocompleteProvider).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.setupAutocompleteProvider", () => {
	test("stacks wrapper factories over a fresh base provider", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const calls: string[] = [];

		const wrap1: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap1");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap1");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap1");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});
		const wrap2: AutocompleteProviderFactory = (current): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				calls.push("getSuggestions:wrap2");
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				calls.push("applyCompletion:wrap2");
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				calls.push("shouldTrigger:wrap2");
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [wrap1, wrap2],
		};

		(InteractiveMode as any).prototype.setupAutocompleteProvider.call(fakeThis);

		expect(defaultEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(customEditor.setAutocompleteProvider).toHaveBeenCalledTimes(1);
		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider).toBe(customEditor.setAutocompleteProvider.mock.calls[0]?.[0]);
		expect(provider.shouldTriggerFileCompletion?.(["foo"], 0, 3)).toBe(true);
		expect(calls).toEqual(["shouldTrigger:wrap2", "shouldTrigger:wrap1"]);
	});

	test("merges triggerCharacters from wrapper factories", () => {
		const defaultEditor = { setAutocompleteProvider: vi.fn() };
		const customEditor = { setAutocompleteProvider: vi.fn() };
		const passThrough =
			(triggerCharacters: string[]): AutocompleteProviderFactory =>
			(current) => ({
				triggerCharacters,
				getSuggestions: (lines, cursorLine, cursorCol, options) =>
					current.getSuggestions(lines, cursorLine, cursorCol, options),
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			});

		const fakeThis = {
			createBaseAutocompleteProvider: () => new CombinedAutocompleteProvider([], "/tmp/project", undefined),
			defaultEditor,
			editor: customEditor,
			autocompleteProviderWrappers: [passThrough(["$"]), passThrough(["!"])],
		};

		(
			InteractiveMode as unknown as {
				prototype: { setupAutocompleteProvider: (this: typeof fakeThis) => void };
			}
		).prototype.setupAutocompleteProvider.call(fakeThis);

		const provider = defaultEditor.setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
		expect(provider.triggerCharacters).toEqual(["$", "!"]);
	});
});

describe("InteractiveMode.createBaseAutocompleteProvider", () => {
	test("matches model command arguments across provider/model fragments", async () => {
		type TestModel = { id: string; provider: string; name: string };
		type FakeInteractiveMode = {
			session: {
				scopedModels: Array<{ model: TestModel }>;
				modelRegistry: { getAvailable: () => TestModel[] };
				promptTemplates: [];
				extensionRunner: { getRegisteredCommands: () => [] };
				resourceLoader: { getSkills: () => { skills: [] } };
			};
			settingsManager: { getEnableSkillCommands: () => boolean };
			skillCommands: Map<string, string>;
			sessionManager: { getCwd: () => string };
			fdPath: null;
		};

		const createBaseAutocompleteProvider = (
			InteractiveMode as unknown as {
				prototype: { createBaseAutocompleteProvider(this: FakeInteractiveMode): AutocompleteProvider };
			}
		).prototype.createBaseAutocompleteProvider;
		const models = [
			{ id: "gpt-5.2-codex", provider: "github-copilot", name: "GPT-5.2 Codex" },
			{ id: "gpt-5.5", provider: "openai-codex", name: "GPT-5.5" },
		];
		const fakeThis: FakeInteractiveMode = {
			session: {
				scopedModels: [],
				modelRegistry: { getAvailable: () => models },
				promptTemplates: [],
				extensionRunner: { getRegisteredCommands: () => [] },
				resourceLoader: { getSkills: () => ({ skills: [] }) },
			},
			settingsManager: { getEnableSkillCommands: () => false },
			skillCommands: new Map(),
			sessionManager: { getCwd: () => "/tmp" },
			fdPath: null,
		};

		const provider = createBaseAutocompleteProvider.call(fakeThis);
		const suggest = async (line: string) =>
			(
				await provider.getSuggestions([line], 0, line.length, {
					signal: new AbortController().signal,
				})
			)?.items.map((item) => item.value);

		// A concatenated provider+model fragment matches the provider whose
		// provider/id reads in that order, and only that one.
		expect(await suggest("/model codexgpt")).toEqual(["openai-codex/gpt-5.5"]);

		// Space-separated fragments match either field order, ranking the
		// exact provider ("codex" + "gpt") ahead of the reverse-order id match.
		expect(await suggest("/model codex gpt")).toEqual(["openai-codex/gpt-5.5", "github-copilot/gpt-5.2-codex"]);

		// A version that does not exist must not fuzzily match a nearby version
		// (no candidates match, so the provider yields no suggestions).
		expect(await suggest("/model gpt-5.4")).toBeUndefined();
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		toolOutputExpanded?: boolean;
		cwd?: string;
		contextFiles?: Array<{ path: string; content?: string }>;
		rulesFiles?: Array<{ path: string; content?: string }>;
		extensions?: ExtensionFixture[];
		skills?: Array<{ filePath: string; name: string }>;
		activeToolNames?: string[];
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
		useRealScopeGroups?: boolean;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			toolOutputExpanded: options.toolOutputExpanded ?? false,
			loadedResourcesContainer: new Container(),
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			sessionManager: {
				getCwd: () => options.cwd ?? "/tmp/project",
			},
			session: {
				promptTemplates: [],
				getActiveToolNames: () => options.activeToolNames ?? [],
				extensionRunner: {
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: options.contextFiles ?? [] }),
					getRulesFiles: () => ({ rulesFiles: options.rulesFiles ?? [] }),
					getRulesContent: () => undefined,
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ extensions: options.extensions ?? [], errors: [], runtime: {} }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => (InteractiveMode as any).prototype.formatDisplayPath.call(fakeThis, p),
			formatExtensionDisplayPath: (p: string) =>
				(InteractiveMode as any).prototype.formatExtensionDisplayPath.call(fakeThis, p),
			formatContextPath: (p: string) => (InteractiveMode as any).prototype.formatContextPath.call(fakeThis, p),
			getStartupExpansionState: () => (InteractiveMode as any).prototype.getStartupExpansionState.call(fakeThis),
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			isPackageSource: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.isPackageSource.call(fakeThis, sourceInfo),
			getShortPath: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getShortPath.call(fakeThis, p, sourceInfo),
			getCompactPathLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPathLabel.call(fakeThis, p, sourceInfo),
			getCompactPackageSourceLabel: (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactPackageSourceLabel.call(fakeThis, sourceInfo),
			getCompactExtensionLabel: (p: string, sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabel.call(fakeThis, p, sourceInfo),
			getCompactDisplayPathSegments: (p: string) =>
				(InteractiveMode as any).prototype.getCompactDisplayPathSegments.call(fakeThis, p),
			getCompactNonPackageExtensionLabel: (
				p: string,
				index: number,
				allPaths: Array<{ path: string; segments: string[] }>,
			) => (InteractiveMode as any).prototype.getCompactNonPackageExtensionLabel.call(fakeThis, p, index, allPaths),
			getCompactExtensionLabels: (extensions: ExtensionFixture[]) =>
				(InteractiveMode as any).prototype.getCompactExtensionLabels.call(fakeThis, extensions),
			formatDiagnostics: () => "diagnostics",
			getBuiltInCommandConflictDiagnostics: () => [],
		};

		if (options.useRealScopeGroups) {
			fakeThis.getScopeGroup = (sourceInfo?: SourceInfo) =>
				(InteractiveMode as any).prototype.getScopeGroup.call(fakeThis, sourceInfo);
			fakeThis.buildScopeGroups = (items: Array<{ path: string; sourceInfo?: SourceInfo }>) =>
				(InteractiveMode as any).prototype.buildScopeGroups.call(fakeThis, items);
			fakeThis.formatScopeGroups = (groups: unknown, formatOptions: unknown) =>
				(InteractiveMode as any).prototype.formatScopeGroups.call(fakeThis, groups, formatOptions);
		}

		return fakeThis;
	}

	function createSourceInfo(
		filePath: string,
		options: {
			source: string;
			scope: "user" | "project" | "temporary";
			origin: "package" | "top-level";
			baseDir?: string;
		},
	): SourceInfo {
		return {
			path: filePath,
			source: options.source,
			scope: options.scope,
			origin: options.origin,
			baseDir: options.baseDir,
		};
	}

	function createExtensionFixtures(): ExtensionFixture[] {
		return [
			{
				path: "/tmp/project/.pi/extensions/answer.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/answer.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/extensions/local-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/extensions/local-index/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/project/.pi/extensions",
				}),
			},
			{
				path: "/tmp/agent/extensions/user-index/index.ts",
				sourceInfo: createSourceInfo("/tmp/agent/extensions/user-index/index.ts", {
					source: "local",
					scope: "user",
					origin: "top-level",
					baseDir: "/tmp/agent/extensions",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
			{
				path: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/@scope/pi-scoped/extensions/index.ts", {
					source: "npm:@scope/pi-scoped",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/@scope/pi-scoped",
				}),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
				sourceInfo: createSourceInfo(
					"/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents/extensions/subagents/index.ts",
					{
						source: "git:github.com/HazAT/pi-interactive-subagents",
						scope: "project",
						origin: "package",
						baseDir: "/tmp/project/.pi/git/github.com/HazAT/pi-interactive-subagents",
					},
				),
			},
			{
				path: "/tmp/temp/cli-extension.ts",
				sourceInfo: createSourceInfo("/tmp/temp/cli-extension.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/temp",
				}),
			},
		];
	}

	test("shows a compact resource listing by default", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("commit");
		expect(output).not.toContain("resource-list");
	});

	test("shows active tools in startup resources", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			activeToolNames: ["read", "bash", "edit", "write"],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Tools]");
		expect(output).toContain("bash, edit, read, write");
	});

	test("shows user rules separately from context files in startup resources", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd: "/tmp/project",
			contextFiles: [{ path: "/tmp/project/AGENTS.md" }],
			rulesFiles: [{ path: "/home/osso/AgentConfig/rules/01-identity.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Context]");
		expect(output).toContain("AGENTS.md");
		expect(output).toContain("[User Rules]");
		expect(output).toContain("~/AgentConfig/rules/01-identity.md");
	});

	test("shows full resource listing when expanded", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("shows full resource listing on verbose startup even when tool output is collapsed", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			verbose: true,
			toolOutputExpanded: false,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skills]");
		expect(output).toContain("resource-list");
		expect(output).not.toContain("commit");
	});

	test("abbreviates extensions in compact listing", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: [{ path: "/tmp/extensions/answer.ts" }, { path: "/tmp/extensions/btw.ts" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Extensions]");
		expect(output).toContain("answer.ts, btw.ts");
		expect(output).not.toContain("extensions/answer.ts");
	});

	test("captures mixed extension layouts in compact output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  @scope/pi-scoped, answer.ts, cli-extension.ts, HazAT/pi-interactive-subagents, HazAT/pi-interactive-subagents:subagents, local-index, pi-markdown-preview, user-index"`);
	});

	test("adds more parent folders until local extension labels are unique", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
			{
				path: "/tmp/gamma/one/index.ts",
				sourceInfo: createSourceInfo("/tmp/gamma/one/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/gamma",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/one, beta/one, gamma/one"`);
	});

	test("strips index.ts from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("strips index.js from local extension label, showing parent dir", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/plan-mode/index.js",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.js", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode"`);
	});

	test("mixed single-file and subdirectory index.ts extensions strip index.ts", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/webfetch.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/webfetch.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/plan-mode/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/plan-mode/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  plan-mode, webfetch.ts"`);
	});

	test("multiple index.ts with unique parent dirs need no disambiguation", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/foo/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/foo/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
			{
				path: "/tmp/extensions/bar/index.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/bar/index.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  bar, foo"`);
	});

	test("multiple index.ts with same parent dir name disambiguated with grandparent", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/alpha/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/alpha/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/alpha",
				}),
			},
			{
				path: "/tmp/beta/tools/index.ts",
				sourceInfo: createSourceInfo("/tmp/beta/tools/index.ts", {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
					baseDir: "/tmp/beta",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  alpha/tools, beta/tools"`);
	});

	test("non-index file in subdirectory stays as filename", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/extensions/my-ext/main.ts",
				sourceInfo: createSourceInfo("/tmp/extensions/my-ext/main.ts", {
					source: "local",
					scope: "project",
					origin: "top-level",
					baseDir: "/tmp/extensions",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  main.ts"`);
	});

	test("package extensions still strip index.ts correctly (regression guard)", () => {
		const extensions: ExtensionFixture[] = [
			{
				path: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts",
				sourceInfo: createSourceInfo("/tmp/project/.pi/npm/node_modules/pi-markdown-preview/extensions/index.ts", {
					source: "npm:pi-markdown-preview",
					scope: "project",
					origin: "package",
					baseDir: "/tmp/project/.pi/npm/node_modules/pi-markdown-preview",
				}),
			},
		];

		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			extensions,
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  pi-markdown-preview"`);
	});
	test("captures mixed extension layouts in expanded output", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			extensions: createExtensionFixtures(),
			useRealScopeGroups: true,
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		expect(normalizeRenderedOutput(fakeThis.loadedResourcesContainer)).toMatchInlineSnapshot(`
"[Extensions]
  project
    /tmp/project/.pi/extensions/answer.ts
    /tmp/project/.pi/extensions/local-index
    git:github.com/HazAT/pi-interactive-subagents
      extensions
      extensions/subagents
    npm:@scope/pi-scoped
      extensions
    npm:pi-markdown-preview
      extensions
  user
    /tmp/agent/extensions/user-index
  path
    /tmp/temp/cli-extension.ts"`);
	});

	test("shows context paths relative to cwd while preserving full external paths", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".config", "pi", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.config/pi/agent/AGENTS.md, AGENTS.md");
		expect(output).not.toContain(`${cwd.replace(/\\/g, "/")}/AGENTS.md`);
	});

	test("shows full context paths when expanded", () => {
		const home = homedir();
		const cwd = path.join(home, "Development", "pi-mono");
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: false,
			toolOutputExpanded: true,
			cwd,
			contextFiles: [
				{ path: path.join(home, ".config", "pi", "agent", "AGENTS.md") },
				{ path: path.join(cwd, "AGENTS.md") },
			],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer).replace(/\\/g, "/");
		expect(output).toContain("[Context]");
		expect(output).toContain("~/.config/pi/agent/AGENTS.md");
		expect(output).toContain("~/Development/pi-mono/AGENTS.md");
		expect(output).not.toContain("~/.config/pi/agent/AGENTS.md, AGENTS.md");
	});

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensions: [{ path: "/tmp/ext/index.ts" }],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.loadedResourcesContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md", name: "commit" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.loadedResourcesContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});
