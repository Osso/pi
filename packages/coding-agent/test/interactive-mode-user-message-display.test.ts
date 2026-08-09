import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent, PromptOptions } from "../src/core/agent-session.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

type PromptWithPreparedMessage = (text: string, options?: PromptOptions) => Promise<void>;

type InteractiveModeTestThis = {
	chatContainer: Container;
	isInitialized: boolean;
	isViewingAgentSession: () => boolean;
	handleHiddenMainSessionDisplayEvent: (event: AgentSessionEvent) => boolean;
	cancelPartialUpdateRender: () => void;
	getMarkdownThemeWithSettings: typeof getMarkdownTheme;
	runtimeHost: { session: { prompt: PromptWithPreparedMessage } };
	clipboardTempFiles: { cleanupReferencedIn: (text: string) => void };
	showError: (message: string) => void;
	toolOutputExpanded: boolean;
	updatePendingMessagesDisplay: () => void;
	ui: { requestRender: () => void };
};

const handleEvent = (
	InteractiveMode.prototype as unknown as {
		handleEvent(this: InteractiveModeTestThis, event: AgentSessionEvent): Promise<void>;
	}
).handleEvent;
const handleHiddenMainSessionDisplayEvent = (
	InteractiveMode.prototype as unknown as {
		handleHiddenMainSessionDisplayEvent(this: InteractiveModeTestThis, event: AgentSessionEvent): boolean;
	}
).handleHiddenMainSessionDisplayEvent;
const submitMainLoopInput = (
	InteractiveMode.prototype as unknown as {
		submitMainLoopInput(this: InteractiveModeTestThis, userInput: string): Promise<void>;
	}
).submitMainLoopInput;

function createInteractiveModeTestThis(
	session: InteractiveModeTestThis["runtimeHost"]["session"],
	options: { isViewingAgentSession?: () => boolean; requestRender?: () => void } = {},
): InteractiveModeTestThis {
	return Object.assign(Object.create(InteractiveMode.prototype) as InteractiveModeTestThis, {
		chatContainer: new Container(),
		isInitialized: true,
		isViewingAgentSession: options.isViewingAgentSession ?? (() => false),
		handleHiddenMainSessionDisplayEvent,
		cancelPartialUpdateRender: () => {},
		getMarkdownThemeWithSettings: getMarkdownTheme,
		runtimeHost: { session },
		clipboardTempFiles: { cleanupReferencedIn: () => {} },
		showError: () => {},
		toolOutputExpanded: false,
		updatePendingMessagesDisplay: () => {},
		ui: { requestRender: options.requestRender ?? (() => {}) },
	});
}

function createPreparedUserMessage(text = "prepared user message"): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createUserMessageStart(message: AgentMessage): AgentSessionEvent {
	return { type: "message_start", message };
}

function getRenderedUserMessages(container: Container): UserMessageComponent[] {
	return container.children.filter((child): child is UserMessageComponent => child instanceof UserMessageComponent);
}

function renderChat(container: Container): string {
	return container.render(80).join("\n");
}

describe("prepared user-message lifecycle", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	test("exposes the transformed prepared message before deferred before_agent_start and message_start", async () => {
		const beforeAgentStart = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "transform", text: "transformed user message" }));
					pi.on("before_agent_start", async () => {
						await beforeAgentStart.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("response")]);

		const preparedMessages: AgentMessage[] = [];
		const promptPromise = harness.session.prompt("raw user message", {
			onUserMessagePrepared: (message) => preparedMessages.push(message),
		});

		try {
			await vi.waitFor(() => expect(preparedMessages).toHaveLength(1));
			expect(getMessageText(preparedMessages[0])).toBe("transformed user message");
			expect(harness.eventsOfType("message_start")).toHaveLength(0);

			beforeAgentStart.resolve();
			await promptPromise;

			const userMessageStarts = harness
				.eventsOfType("message_start")
				.filter((event) => event.message.role === "user");
			expect(userMessageStarts).toHaveLength(1);
			expect(getMessageText(userMessageStarts[0]?.message)).toBe("transformed user message");
		} finally {
			beforeAgentStart.resolve();
			await promptPromise;
		}
	});

	test("renders prepared content before prompt settlement and reconciles the exact message_start once", async () => {
		const preparedMessage = createPreparedUserMessage();
		const promptCompletion = createDeferred();
		let promptSettled = false;
		const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.onUserMessagePrepared?.(preparedMessage);
			await promptCompletion.promise;
			promptSettled = true;
		});
		const fakeThis = createInteractiveModeTestThis({ prompt });
		const promptPromise = submitMainLoopInput.call(fakeThis, "raw");

		try {
			await vi.waitFor(() => expect(renderChat(fakeThis.chatContainer)).toContain("prepared user message"));
			expect(promptSettled).toBe(false);

			await handleEvent.call(fakeThis, createUserMessageStart(preparedMessage));
			expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(1);
			expect(renderChat(fakeThis.chatContainer)).toContain("prepared user message");
			expect(promptSettled).toBe(false);

			promptCompletion.resolve();
			await promptPromise;
			expect(promptSettled).toBe(true);
			expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(1);
		} finally {
			promptCompletion.resolve();
			await promptPromise;
		}
	});

	test("falls back to the authoritative message after a transcript rebuild", async () => {
		const preparedMessage = createPreparedUserMessage();
		const promptCompletion = createDeferred();
		let fakeThis!: InteractiveModeTestThis;
		const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.onUserMessagePrepared?.(preparedMessage);
			await promptCompletion.promise;
		});
		fakeThis = createInteractiveModeTestThis({ prompt });
		const promptPromise = submitMainLoopInput.call(fakeThis, "raw");

		try {
			await vi.waitFor(() => expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(1));
			const provisionalMessage = getRenderedUserMessages(fakeThis.chatContainer)[0];
			const rebuiltTranscript = new Container();
			fakeThis.chatContainer.clear();
			fakeThis.chatContainer.addChild(rebuiltTranscript);

			await handleEvent.call(fakeThis, createUserMessageStart(preparedMessage));

			expect(fakeThis.chatContainer.children[0]).toBe(rebuiltTranscript);
			expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(1);
			expect(getRenderedUserMessages(fakeThis.chatContainer)[0]).not.toBe(provisionalMessage);
			expect(renderChat(fakeThis.chatContainer)).toContain("prepared user message");
		} finally {
			promptCompletion.resolve();
			await promptPromise;
		}
	});

	test("renders cleanup after a prompt ends without an authoritative message_start", async () => {
		const preparedMessage = createPreparedUserMessage();
		const requestRender = vi.fn();
		const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.onUserMessagePrepared?.(preparedMessage);
		});
		const fakeThis = createInteractiveModeTestThis({ prompt }, { requestRender });

		await submitMainLoopInput.call(fakeThis, "raw");

		expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(0);
		expect(renderChat(fakeThis.chatContainer)).not.toContain("prepared user message");
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	test("keeps main-session prepared and authoritative messages out of a child transcript", async () => {
		const preparedMessage = createPreparedUserMessage();
		const promptCompletion = createDeferred();
		const childTranscript = new Container();
		const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.onUserMessagePrepared?.(preparedMessage);
			await promptCompletion.promise;
		});
		const fakeThis = createInteractiveModeTestThis({ prompt }, { isViewingAgentSession: () => true });
		fakeThis.chatContainer.addChild(childTranscript);
		const promptPromise = submitMainLoopInput.call(fakeThis, "raw");

		try {
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
			expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(0);
			expect(fakeThis.chatContainer.children).toEqual([childTranscript]);

			await handleEvent.call(fakeThis, createUserMessageStart(preparedMessage));
			expect(getRenderedUserMessages(fakeThis.chatContainer)).toHaveLength(0);
			expect(fakeThis.chatContainer.children).toEqual([childTranscript]);
		} finally {
			promptCompletion.resolve();
			await promptPromise;
		}
	});
});
