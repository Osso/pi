import assert from "node:assert/strict";
import type { Component, EditorComponent, LoaderIndicatorOptions, RootLayoutRect } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

class WorkingEditor implements EditorComponent {
	working = false;
	indicator: LoaderIndicatorOptions | undefined;
	origin: { row: number; col: number } | undefined;

	render(_width: number): string[] {
		return [this.working ? "working" : "idle"];
	}
	invalidate(): void {}
	handleInput(_data: string): void {}
	getText(): string {
		return "";
	}
	setText(_text: string): void {}
	setWorking(working: boolean): void {
		this.working = working;
	}
	setWorkingIndicator(indicator?: LoaderIndicatorOptions): void {
		this.indicator = indicator;
	}
	setScreenOrigin(row: number, col: number): void {
		this.origin = { row, col };
	}
	clearScreenOrigin(): void {
		this.origin = undefined;
	}
}

class PlainEditor implements EditorComponent {
	render(_width: number): string[] {
		return ["plain"];
	}
	invalidate(): void {}
	handleInput(_data: string): void {}
	getText(): string {
		return "";
	}
	setText(_text: string): void {}
}

type LoaderStub = {
	setIndicator(indicator?: LoaderIndicatorOptions): void;
	setMessage(message: string): void;
};

type InteractiveMethod = (this: SyncContext) => void;
type HandleEditorLayout = (this: SyncContext, rect: RootLayoutRect) => void;
type SetWorkingIndicator = (this: SyncContext, options?: LoaderIndicatorOptions) => void;
type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;

type AgentEndContext = {
	cancelPartialUpdateRender(): void;
	checkShutdownRequested(): Promise<void>;
	clearPendingToolComponents(): void;
	discardStreamingComponent(): void;
	editor: EditorComponent;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	init(): Promise<void>;
	isInitialized: boolean;
	handleHiddenMainSessionDisplayEvent(event: AgentSessionEvent): boolean;
	isViewingAgentSession(): boolean;
	notifyResponseComplete(event: AgentEndEvent): void;
	settingsManager: { getShowTerminalProgress(): boolean };
	stopThinkingTimer(): void;
	stopToolWaitingTimerIfIdle(): void;
	stopChildActivityTimer(): void;
	stopWorkingLoader(): void;
	streamingComponent: undefined;
	thinkingFollowsTool: boolean;
	ui: { requestRender(): void; terminal: { setProgress(active: boolean): void } };
};

type HandleEvent = (this: AgentEndContext, event: AgentSessionEvent) => Promise<void>;

type SyncContext = {
	createWorkingLoader(indicator?: LoaderIndicatorOptions): LoaderStub;
	createdIndicators: Array<LoaderIndicatorOptions | undefined>;
	editor: EditorComponent;
	editorContainer: { children: Component[] };
	getWorkingLoaderIndicator(view: "main" | "child"): LoaderIndicatorOptions | undefined;
	getWorkingLoaderMessage(): string;
	isSelectedChildWorking(): boolean;
	isViewingAgentSession(): boolean;
	loadingAnimation: LoaderStub | undefined;
	promptActivitySources: Set<string>;
	session: { isStreaming: boolean };
	startChildActivityTimer(): void;
	statusContainer: { addChild(component: Component): void };
	stopWorkingLoader(): void;
	syncWorkingEditorState(): void;
	updateWorkingLoaderIndicator(): void;
	ui: { requestRender(): void };
	workingIndicatorOptions: LoaderIndicatorOptions | undefined;
	workingLoaderView: "main" | "child" | undefined;
	workingVisible: boolean;
};

const prototype = InteractiveMode.prototype as unknown as {
	getWorkingLoaderIndicator(this: SyncContext, view: "main" | "child"): LoaderIndicatorOptions | undefined;
	handleEditorLayout: HandleEditorLayout;
	handleEvent: HandleEvent;
	setWorkingIndicator: SetWorkingIndicator;
	syncWorkingEditorState: InteractiveMethod;
	syncWorkingLoaderVisibility: InteractiveMethod;
	updateWorkingLoaderIndicator: InteractiveMethod;
};

function createLoaderStub(): LoaderStub {
	return {
		setIndicator: vi.fn(),
		setMessage: vi.fn(),
	};
}

function createContext(editor: EditorComponent): SyncContext {
	const loadingAnimation = createLoaderStub();
	let context: SyncContext;
	context = {
		createWorkingLoader: (indicator?: LoaderIndicatorOptions) => {
			context.createdIndicators.push(indicator);
			return createLoaderStub();
		},
		createdIndicators: [] as Array<LoaderIndicatorOptions | undefined>,
		editor,
		editorContainer: { children: [editor as Component] },
		getWorkingLoaderIndicator: (view: "main" | "child"): LoaderIndicatorOptions | undefined =>
			prototype.getWorkingLoaderIndicator.call(context, view),
		getWorkingLoaderMessage: () => "Streaming...",
		isSelectedChildWorking: () => false,
		isViewingAgentSession: () => false,
		loadingAnimation,
		promptActivitySources: new Set(),
		session: { isStreaming: true },
		startChildActivityTimer: vi.fn(),
		statusContainer: { addChild: vi.fn() },
		stopWorkingLoader: vi.fn(),
		syncWorkingEditorState: () => prototype.syncWorkingEditorState.call(context),
		updateWorkingLoaderIndicator: () => prototype.updateWorkingLoaderIndicator.call(context),
		ui: { requestRender: vi.fn() },
		workingIndicatorOptions: { frames: ["a", "b"], intervalMs: 120 },
		workingLoaderView: "main" as "main" | "child" | undefined,
		workingVisible: true,
	};
	return context;
}

describe("InteractiveMode working editor", () => {
	it("keeps the editor prompt static while the status shows the working animation", () => {
		const editor = new WorkingEditor();
		const context = createContext(editor);
		context.loadingAnimation = undefined;
		context.workingLoaderView = undefined;

		prototype.syncWorkingLoaderVisibility.call(context);

		assert.strictEqual(editor.render(80)[0], "idle");
		assert.deepStrictEqual(context.createdIndicators, [context.workingIndicatorOptions]);
	});

	it("keeps the main editor static while retaining the working label", () => {
		const editor = new WorkingEditor();
		const context = createContext(editor);
		const label = context.loadingAnimation?.setMessage;

		prototype.syncWorkingLoaderVisibility.call(context);

		assert.strictEqual(editor.working, false);
		expect(label).toHaveBeenCalledWith("Streaming...");

		context.session.isStreaming = false;
		prototype.syncWorkingLoaderVisibility.call(context);
		assert.strictEqual(editor.working, false);
	});

	it("shows selected child activity in the status instead of the prompt", () => {
		const editor = new WorkingEditor();
		const context = createContext(editor);
		context.isViewingAgentSession = () => true;
		context.isSelectedChildWorking = () => true;
		context.loadingAnimation = undefined;
		context.workingLoaderView = undefined;

		prototype.syncWorkingLoaderVisibility.call(context);

		assert.strictEqual(editor.working, false);
		assert.deepStrictEqual(context.createdIndicators, [context.workingIndicatorOptions]);
	});

	it("shows the status indicator when the editor lacks fixed-cell support", () => {
		const editor = new PlainEditor();
		const context = createContext(editor);
		context.loadingAnimation = undefined;
		context.workingLoaderView = undefined;

		prototype.syncWorkingLoaderVisibility.call(context);

		assert.deepStrictEqual(context.createdIndicators, [context.workingIndicatorOptions]);
	});

	it("shows wide custom frames in the status instead of the editor prompt", () => {
		const editor = new WorkingEditor();
		const context = createContext(editor);
		context.loadingAnimation = undefined;
		context.workingIndicatorOptions = { frames: ["XX", "YY"], intervalMs: 120 };
		context.workingLoaderView = undefined;

		prototype.syncWorkingLoaderVisibility.call(context);

		assert.strictEqual(editor.working, false);
		assert.strictEqual(editor.indicator, undefined);
		assert.deepStrictEqual(context.createdIndicators, [context.workingIndicatorOptions]);
	});

	it("clears only prompt placement while a working editor is temporarily replaced", () => {
		const editor = new WorkingEditor();
		editor.setWorking(true);
		editor.setScreenOrigin(2, 1);
		const context = createContext(editor);
		context.editorContainer.children = [];

		prototype.handleEditorLayout.call(context, { row: 7, col: 3, width: 20, height: 4 });

		assert.strictEqual(editor.working, true);
		assert.strictEqual(editor.origin, undefined);

		context.editorContainer.children = [editor];
		prototype.handleEditorLayout.call(context, { row: 7, col: 3, width: 20, height: 4 });
		assert.deepStrictEqual(editor.origin, { row: 7, col: 3 });
	});

	it("updates the active child status indicator when options change", () => {
		const editor = new WorkingEditor();
		const context = createContext(editor);
		const indicator = { frames: ["x", "y"], intervalMs: 80 };
		context.isViewingAgentSession = () => true;
		context.isSelectedChildWorking = () => true;
		context.workingLoaderView = "child";

		prototype.setWorkingIndicator.call(context, indicator);

		assert.deepStrictEqual(context.workingIndicatorOptions, indicator);
		assert.strictEqual(editor.working, false);
		expect(context.loadingAnimation?.setIndicator).toHaveBeenCalledWith(indicator);
	});

	it("updates the main status with the custom indicator", () => {
		const editor = new WorkingEditor();
		const context = createContext(editor);
		const indicator = { frames: ["x", "y"], intervalMs: 80 };

		prototype.setWorkingIndicator.call(context, indicator);

		expect(context.loadingAnimation?.setIndicator).toHaveBeenCalledWith(indicator);
	});

	it("restores the idle prompt when agent_end arrives before streaming state clears", async () => {
		const editor = new WorkingEditor();
		editor.setWorking(true);
		const context: AgentEndContext = {
			cancelPartialUpdateRender: vi.fn(),
			checkShutdownRequested: async () => {},
			clearPendingToolComponents: vi.fn(),
			discardStreamingComponent: vi.fn(),
			editor,
			executingToolNames: new Map(),
			executingToolStartedAt: new Map(),
			init: async () => {},
			isInitialized: true,
			handleHiddenMainSessionDisplayEvent: () => false,
			isViewingAgentSession: () => false,
			notifyResponseComplete: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			stopThinkingTimer: vi.fn(),
			stopToolWaitingTimerIfIdle: vi.fn(),
			stopChildActivityTimer: vi.fn(),
			stopWorkingLoader: vi.fn(),
			streamingComponent: undefined,
			thinkingFollowsTool: true,
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const event: AgentEndEvent = { type: "agent_end", messages: [], willRetry: false };

		await prototype.handleEvent.call(context, event);

		assert.strictEqual(editor.working, false);
	});
});
