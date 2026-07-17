import { Container, type Loader } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS } from "../src/core/desktop-notification.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const desktopNotifier = vi.hoisted(() => vi.fn());

vi.mock("../src/core/desktop-notification.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/desktop-notification.ts")>();
	return {
		...actual,
		sendDesktopNotification: desktopNotifier,
	};
});

type HandleEventContext = {
	chatContainer: Container;
	clearPendingToolComponents(): void;
	completedToolTimings: Map<string, { startedAt: number; finishedAt: number }>;
	closeResponseCompleteNotification(): void;
	defaultEditor: { onEscape?: () => void };
	defaultStreamingMessage: string;
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	footer: { invalidate(): void };
	hideThinkingBlock: boolean;
	isInitialized: boolean;
	currentWorkingDefaultMessage: string;
	loadingAnimation: Loader | undefined;
	multiAgentStore: undefined;
	pendingTools: Map<string, { dispose(): void }>;
	retryCountdown: { dispose(): void } | undefined;
	retryEscapeHandler: (() => void) | undefined;
	retryLoader: Loader | undefined;
	runtimeHost: {
		session: {
			abortRetry(): void;
			isStreaming: boolean;
			settingsManager: { getShowTerminalProgress(): boolean };
		};
	};
	shutdownRequested: boolean;
	setDefaultWorkingMessage(message: string): void;
	setWorkingMessageForActiveTools(): void;
	startThinkingTimer(): void;
	statusContainer: Container;
	stopThinkingTimer(): void;
	stopToolWaitingTimerIfIdle(): void;
	stopWorkingLoader(): void;
	streamingComponent: { updateContent(message: unknown): void } | undefined;
	streamingMessage: unknown;
	thinkingFollowsTool: boolean;
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
	submitSelectedAgentSteering: () => Promise<boolean>;
};

type ModelRequestEvent = { type: "model_request_start" } | { type: "model_request_end" };

type InteractiveModePrototype = {
	closeResponseCompleteNotification(this: { responseCompleteNotification?: { close(): void } }): void;
	handleEvent(this: HandleEventContext, event: AgentSessionEvent | ModelRequestEvent): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
	stopWorkingLoader(this: HandleEventContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(): HandleEventContext {
	const context = Object.create(InteractiveMode.prototype) as HandleEventContext;
	context.chatContainer = new Container();
	context.clearPendingToolComponents = vi.fn();
	context.closeResponseCompleteNotification = vi.fn();
	context.completedToolTimings = new Map();
	context.defaultEditor = {};
	context.defaultStreamingMessage = "Streaming...";
	context.defaultWorkingMessage = "Thinking...";
	context.executingToolNames = new Map();
	context.executingToolStartedAt = new Map();
	context.footer = { invalidate: vi.fn() };
	context.hideThinkingBlock = false;
	context.isInitialized = true;
	context.currentWorkingDefaultMessage = "Thinking...";
	context.loadingAnimation = undefined;
	context.multiAgentStore = undefined;
	context.pendingTools = new Map();
	context.retryCountdown = undefined;
	context.retryEscapeHandler = undefined;
	context.retryLoader = undefined;
	context.runtimeHost = {
		session: { abortRetry: vi.fn(), isStreaming: true, settingsManager: { getShowTerminalProgress: () => false } },
	};
	context.setDefaultWorkingMessage = vi.fn((message: string) => {
		context.currentWorkingDefaultMessage = message;
	});
	context.setWorkingMessageForActiveTools = vi.fn();
	context.shutdownRequested = false;
	context.startThinkingTimer = vi.fn();
	context.statusContainer = new Container();
	context.stopThinkingTimer = vi.fn();
	context.stopToolWaitingTimerIfIdle = vi.fn();
	context.stopWorkingLoader = interactiveModePrototype.stopWorkingLoader;
	context.streamingComponent = undefined;
	context.streamingMessage = undefined;
	context.thinkingFollowsTool = false;
	context.ui = { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } };
	context.workingVisible = true;
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
		submitSelectedAgentSteering: vi.fn(async () => false),
	};
}

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	vi.useRealTimers();
});

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

	it("shows Thinking until the first visible post-tool assistant delta", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_start" });
		expect(context.closeResponseCompleteNotification).toHaveBeenCalledTimes(1);
		expect(context.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking...");

		await interactiveModePrototype.handleEvent.call(context, { type: "model_request_start" });
		expect(context.startThinkingTimer).toHaveBeenCalledTimes(1);

		await interactiveModePrototype.handleEvent.call(context, {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
			startedAt: 1_000,
			finishedAt: 2_000,
		});
		expect(context.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking...");

		await interactiveModePrototype.handleEvent.call(context, { type: "model_request_end" });
		expect(context.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking...");

		context.streamingComponent = { updateContent: vi.fn() };
		context.hideThinkingBlock = true;
		await interactiveModePrototype.handleEvent.call(context, {
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hidden", partial: {} },
		} as AgentSessionEvent);
		expect(context.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking...");

		await interactiveModePrototype.handleEvent.call(context, {
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} },
		} as AgentSessionEvent);
		expect(context.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Streaming...");
	});

	it("does not notify while the agent is about to retry", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_end", messages: [], willRetry: true });

		expect(desktopNotifier).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode retry status", () => {
	it("transfers the retry spinner to normal work and cleans it up after success", async () => {
		vi.useFakeTimers();
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		});
		const retryLoader = context.statusContainer.children[0] as Loader;
		const stop = vi.spyOn(retryLoader, "stop");
		expect(retryLoader.render(100).join("\n")).toContain("Retrying (1/3) in 1s...");
		vi.advanceTimersByTime(1000);

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_start" });

		expect(context.statusContainer.children).toEqual([retryLoader]);
		expect(retryLoader.render(100).join("\n")).toContain("Thinking...");
		expect(context.retryLoader).toBeUndefined();
		expect(context.loadingAnimation).toBe(retryLoader);
		expect(stop).not.toHaveBeenCalled();

		await interactiveModePrototype.handleEvent.call(context, { type: "auto_retry_end", success: true, attempt: 1 });

		expect(context.statusContainer.children).toEqual([retryLoader]);
		expect(stop).not.toHaveBeenCalled();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_end", messages: [], willRetry: false });

		expect(stop).toHaveBeenCalledTimes(1);
		expect(context.loadingAnimation).toBeUndefined();
		expect(context.statusContainer.children).toEqual([]);
	});

	it("cleans up the retry spinner after a final retry failure", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, {
			type: "auto_retry_start",
			attempt: 3,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		});
		const retryLoader = context.retryLoader as Loader;
		const stop = vi.spyOn(retryLoader, "stop");

		await interactiveModePrototype.handleEvent.call(context, {
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "overloaded",
		});

		expect(stop).toHaveBeenCalledTimes(1);
		expect(context.retryLoader).toBeUndefined();
		expect(context.statusContainer.children).toEqual([]);
	});

	it("cancels retry sleep when Escape is pressed", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "overloaded",
		});
		context.defaultEditor.onEscape?.();

		expect(context.runtimeHost.session.abortRetry).toHaveBeenCalledTimes(1);
	});
});
