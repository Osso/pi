import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

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

type HandleEventThis = {
	chatContainer: Container;
	footer: { invalidate(): void };
	getMarkdownThemeWithSettings(): MarkdownTheme;
	hiddenThinkingLabel: string;
	hideThinkingBlock: boolean;
	isInitialized: boolean;
	pendingTools: Map<string, unknown>;
	runtimeHost: { session: { retryAttempt: number } };
	streamingComponent: unknown;
	streamingMessage: AssistantMessage | undefined;
	ui: Pick<TUI, "requestRender">;
};

type HandleEvent = (this: HandleEventThis, event: AgentSessionEvent) => Promise<void>;

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageUpdate(message: AssistantMessage): AgentSessionEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
	};
}

function createFakeInteractiveModeThis(): HandleEventThis {
	return Object.assign(Object.create(InteractiveMode.prototype) as HandleEventThis, {
		chatContainer: new Container(),
		footer: { invalidate: vi.fn() },
		getMarkdownThemeWithSettings: getMarkdownTheme,
		hiddenThinkingLabel: "Thinking...",
		hideThinkingBlock: false,
		isInitialized: true,
		pendingTools: new Map<string, unknown>(),
		runtimeHost: { session: { retryAttempt: 0 } },
		streamingComponent: undefined,
		streamingMessage: undefined,
		ui: { requestRender: vi.fn() },
	});
}

describe("InteractiveMode streaming render throttling", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("coalesces rapid assistant message updates into one delayed render", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const initialMessage = createAssistantMessage("");

		await handleEvent.call(fakeThis, { type: "message_start", message: initialMessage });
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("h")));
		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("he")));
		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("hel")));

		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(49);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("message end renders immediately and leaves no delayed render pending", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const initialMessage = createAssistantMessage("");

		await handleEvent.call(fakeThis, { type: "message_start", message: initialMessage });
		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("partial")));
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await handleEvent.call(fakeThis, { type: "message_end", message: createAssistantMessage("final") });
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(50);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});
});
