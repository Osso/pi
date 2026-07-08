import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
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
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	footer: { invalidate(): void };
	isInitialized: boolean;
	loadingAnimation: undefined;
	multiAgentStore: undefined;
	pendingTools: Map<string, { dispose(): void }>;
	runtimeHost: { session: { settingsManager: { getShowTerminalProgress(): boolean } } };
	shutdownRequested: boolean;
	statusContainer: { clear(): void };
	streamingComponent: undefined;
	streamingMessage: undefined;
	ui: { requestRender(): void; terminal: { setProgress(progress: boolean): void } };
};

type InteractiveModePrototype = {
	handleEvent(this: HandleEventContext, event: AgentSessionEvent): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(): HandleEventContext {
	const context = Object.create(InteractiveMode.prototype) as HandleEventContext;
	context.executingToolNames = new Map();
	context.executingToolStartedAt = new Map();
	context.footer = { invalidate: vi.fn() };
	context.isInitialized = true;
	context.loadingAnimation = undefined;
	context.multiAgentStore = undefined;
	context.pendingTools = new Map();
	context.runtimeHost = { session: { settingsManager: { getShowTerminalProgress: () => false } } };
	context.shutdownRequested = false;
	context.statusContainer = { clear: vi.fn() };
	context.streamingComponent = undefined;
	context.streamingMessage = undefined;
	context.ui = { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } };
	return context;
}

describe("InteractiveMode idle desktop notifications", () => {
	beforeEach(() => {
		desktopNotifier.mockReset();
	});

	it("sends a non-expiring desktop notification after a final agent_end", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_end", messages: [], willRetry: false });

		expect(desktopNotifier).toHaveBeenCalledWith({
			body: "Pi is idle and ready for your next message.",
			expireTimeMs: 0,
			title: "Pi response complete",
			urgency: "normal",
		});
	});

	it("does not notify while the agent is about to retry", async () => {
		const context = createContext();

		await interactiveModePrototype.handleEvent.call(context, { type: "agent_end", messages: [], willRetry: true });

		expect(desktopNotifier).not.toHaveBeenCalled();
	});
});
