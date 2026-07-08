import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS } from "../src/core/desktop-notification.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const desktopNotifier = vi.hoisted(() => vi.fn());

vi.mock("../src/core/desktop-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/desktop-notification.ts")>();
	return {
		...actual,
		sendDesktopNotification: desktopNotifier,
	};
});

type HandleEventContext = {
	clearPendingToolComponents(): void;
	closeResponseCompleteNotification(): void;
	defaultEditor: { onEscape?: () => void };
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	footer: { invalidate(): void };
	isInitialized: boolean;
	loadingAnimation: undefined;
	multiAgentStore: undefined;
	pendingTools: Map<string, { dispose(): void }>;
	retryCountdown: undefined;
	retryEscapeHandler: undefined;
	retryLoader: undefined;
	runtimeHost: { session: { settingsManager: { getShowTerminalProgress(): boolean } } };
	shutdownRequested: boolean;
	setDefaultWorkingMessage(message: string): void;
	statusContainer: { addChild(component: unknown): void; clear(): void };
	stopToolWaitingTimerIfIdle(): void;
	stopWorkingLoader(): void;
	streamingComponent: undefined;
	streamingMessage: undefined;
	ui: { requestRender(): void; terminal: { setProgress(progress: boolean): void } };
	workingVisible: boolean;
};

type SubmitContext = {
	closeResponseCompleteNotification(): void;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	session: {
		isBashRunning: boolean;
		isCompacting: boolean;
		isStreaming: boolean;
		continue: () => Promise<void>;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	showSettingsSelector: () => void;
};

type InteractiveModePrototype = {
	closeResponseCompleteNotification(this: { responseCompleteNotification?: { close(): void } }): void;
	handleEvent(this: HandleEventContext, event: AgentSessionEvent): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(): HandleEventContext {
	const context = Object.create(InteractiveMode.prototype) as HandleEventContext;
	context.clearPendingToolComponents = vi.fn();
	context.closeResponseCompleteNotification = vi.fn();
	context.defaultEditor = {};
	context.defaultWorkingMessage = "Thinking...";
	context.executingToolNames = new Map();
	context.executingToolStartedAt = new Map();
	context.footer = { invalidate: vi.fn() };
	context.isInitialized = true;
	context.loadingAnimation = undefined;
	context.multiAgentStore = undefined;
	context.pendingTools = new Map();
	context.retryCountdown = undefined;
	context.retryEscapeHandler = undefined;
	context.retryLoader = undefined;
	context.runtimeHost = { session: { settingsManager: { getShowTerminalProgress: () => false } } };
	context.setDefaultWorkingMessage = vi.fn();
	context.shutdownRequested = false;
	context.statusContainer = { addChild: vi.fn(), clear: vi.fn() };
	context.stopToolWaitingTimerIfIdle = vi.fn();
	context.stopWorkingLoader = vi.fn();
	context.streamingComponent = undefined;
	context.streamingMessage = undefined;
	context.ui = { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } };
	context.workingVisible = false;
	return context;
}

function createSubmitContext(): SubmitContext {
	return {
		closeResponseCompleteNotification: vi.fn(),
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		session: {
			isBashRunning: false,
			isCompacting: false,
			isStreaming: false,
			continue: vi.fn(async () => {}),
			prompt: vi.fn(async () => {}),
		},
		showSettingsSelector: vi.fn(),
	};
}

describe("InteractiveMode idle desktop notifications", () => {
	beforeEach(() => {
		desktopNotifier.mockReset();
	});

	it("sends a persistent desktop notification after a final agent_end", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_end", messages: [], willRetry: false });

		expect(desktopNotifier).toHaveBeenCalledWith({
			body: "Pi is idle and ready for your next message.",
			expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
			title: "Pi response complete",
			urgency: "normal",
		});
	});

	it("closes the stored idle notification handle", () => {
		const close = vi.fn();
		const context = { responseCompleteNotification: { close } };

		interactiveModePrototype.closeResponseCompleteNotification.call(context);

		expect(close).toHaveBeenCalledTimes(1);
		expect(context.responseCompleteNotification).toBeUndefined();
	});

	it("closes the idle notification when the user submits another prompt", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" next prompt ");

		expect(context.closeResponseCompleteNotification).toHaveBeenCalledTimes(1);
	});

	it("closes the idle notification when the agent starts again", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_start" });

		expect(context.closeResponseCompleteNotification).toHaveBeenCalledTimes(1);
	});

	it("does not notify while the agent is about to retry", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_end", messages: [], willRetry: true });

		expect(desktopNotifier).not.toHaveBeenCalled();
	});
});
