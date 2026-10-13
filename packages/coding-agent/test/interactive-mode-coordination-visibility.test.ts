import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { formatRuntimeMailboxPrompt, formatSharedChannelPrompt } from "../src/core/runtime-coordination-format.ts";
import { createRuntimeMailboxUserMessage } from "../src/core/runtime-mailbox-delivery.ts";
import {
	enqueueRuntimeMailboxMessage,
	getControlDbPath,
	listRuntimeMailboxMessages,
	postSharedChannelMessage,
	type RuntimeMailboxMessage,
	readSharedChannelCursor,
	upsertMultiAgentMailboxMessage,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

interface TestView {
	chatContainer: Container;
	pendingMessagesContainer: Container;
	pendingTools: Map<string, Component>;
	transcriptTailContainer: Container;
	streamingComponent: Component;
	editor: { addToHistory(text: string): void };
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	renderSessionEntries(
		entries: ReturnType<SessionManager["buildContextEntries"]>,
		options?: { populateHistory?: boolean },
	): void;
	showSettingsSelector(): void;
	updatePendingMessagesDisplay(): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
}

const mailbox: RuntimeMailboxMessage = {
	id: 1,
	sender: { sessionId: "sender-session", agentId: "worker" },
	recipient: { sessionId: "recipient-session", agentId: null },
	kind: "message",
	body: "child failed: owner exited",
	createdAt: "2026-10-13T00:00:00.000Z",
	updatedAt: "2026-10-13T00:00:00.000Z",
	status: "pending",
	storeRef: { sessionPath: "/tmp/sender.jsonl", messageId: "mailbox-1" },
};
const mailboxText = formatRuntimeMailboxPrompt(mailbox, "recipient-session");
const broadcastText = formatRuntimeMailboxPrompt(
	{ ...mailbox, senderHost: "agent-server", body: "Broadcast: restart /tmp/pi" },
	"recipient-session",
);
const sharedText = formatSharedChannelPrompt(
	[{ id: 2, sender: mailbox.sender, body: "Release /tmp/shared", createdAt: mailbox.createdAt }],
	"recipient-session",
);
const messages: AgentMessage[] = [
	createRuntimeMailboxUserMessage(mailboxText, "extension"),
	createRuntimeMailboxUserMessage(broadcastText, "extension"),
	createRuntimeMailboxUserMessage(`${mailboxText}\n\n${broadcastText}`, "extension"),
	{ role: "custom", customType: "shared_channel", content: sharedText, display: true, timestamp: 1 },
];

function render(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

function createView(harness: Harness): {
	view: TestView;
	openSettings(): SettingsSelectorComponent;
	history: string[];
} {
	let selector: SettingsSelectorComponent | undefined;
	const history: string[] = [];
	const view = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		transcriptTailContainer: new Container(),
		streamingComponent: new AssistantMessageComponent(
			fauxAssistantMessage("streaming answer"),
			false,
			getMarkdownTheme(),
		),
		pendingTools: new Map(),
		completedToolTimings: new Map(),
		executingToolStartedAt: new Map(),
		compactionQueuedMessages: [],
		editor: { addToHistory: (text: string) => history.push(text) },
		ui: { requestRender: () => {} },
		footer: { invalidate: () => {} },
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getAppKeyDisplay: () => "alt+up",
		themeController: { getTerminalTheme: () => "dark" },
		handleHiddenMainSessionDisplayEvent: () => false,
		isInitialized: true,
		cancelPartialUpdateRender: () => {},
		showSelector: (create: (done: () => void) => { component: SettingsSelectorComponent }) => {
			selector = create(() => {}).component;
		},
	}) as TestView;
	return {
		view,
		history,
		openSettings: () => {
			view.showSettingsSelector();
			if (!selector) throw new Error("Settings selector missing");
			selector.getSettingsList().handleInput("Hide coordination messages");
			return selector;
		},
	};
}

function toggle(selector: SettingsSelectorComponent): void {
	selector.getSettingsList().handleInput("\r");
}

describe("coordination visibility", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	test("defaults visible and persists independently with trusted project precedence", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		expect(settings.getHideCoordinationMessages()).toBe(false);
		settings.setHideCoordinationMessages(true);
		await settings.flush();
		expect(SettingsManager.fromStorage(storage).getHideCoordinationMessages()).toBe(true);
		expect(SettingsManager.fromStorage(storage).getHideToolOutput()).toBe(false);
		storage.withLock("project", () => JSON.stringify({ hideCoordinationMessages: false }));
		expect(SettingsManager.fromStorage(storage).getHideCoordinationMessages()).toBe(false);
	});

	test("settings toggle hides and restores live notices without disturbing streaming, tools, errors or editor history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const { view, openSettings, history } = createView(harness);
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "/tmp/foo" }, { id: "tool-1" }), { stopReason: "toolUse" }),
		);
		view.renderSessionEntries(harness.sessionManager.buildContextEntries());
		const tool = view.pendingTools.get("tool-1");
		expect(tool).toBeDefined();
		for (const message of messages) view.addMessageToChat(message);
		view.addMessageToChat(createRuntimeMailboxUserMessage(mailboxText, "interactive"), { populateHistory: true });
		view.addMessageToChat(createRuntimeMailboxUserMessage("Unrelated extension error", "extension"));
		view.chatContainer.addChild(new Text("Tool error: permission denied", 0, 0));
		view.transcriptTailContainer.addChild(view.streamingComponent);
		const before = render(view.chatContainer);
		const children = [...view.chatContainer.children];
		const selector = openSettings();
		expect(render(selector)).toContain("Hide coordination messages");
		toggle(selector);
		const hidden = render(view.chatContainer);
		expect(hidden).not.toContain("Broadcast: restart");
		expect(hidden).not.toContain("Release /tmp/shared");
		expect(hidden.match(/child failed: owner exited/g)).toHaveLength(1);
		expect(hidden).toContain("Unrelated extension error");
		expect(hidden).toContain("Tool error: permission denied");
		expect(view.pendingTools.get("tool-1")).toBe(tool);
		expect(render(view.transcriptTailContainer)).toContain("streaming answer");
		expect(history).toEqual([mailboxText]);
		toggle(selector);
		expect(render(view.chatContainer)).toBe(before);
		expect(view.chatContainer.children).toEqual(children);
	});

	test("tool-result errors containing coordination envelopes remain visible", async () => {
		const harness = await createHarness({ settings: { hideCoordinationMessages: true } });
		harnesses.push(harness);
		harness.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("read", { path: "/tmp/missing" }, { id: "failed-read" }), {
				stopReason: "toolUse",
			}),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "failed-read",
			toolName: "read",
			content: [{ type: "text", text: mailboxText }],
			isError: true,
			timestamp: 1,
		});
		const { view, openSettings } = createView(harness);
		view.renderSessionEntries(harness.sessionManager.buildContextEntries());
		const hidden = render(view.chatContainer);
		expect(hidden).toContain("child failed: owner exited");
		toggle(openSettings());
		expect(render(view.chatContainer)).toBe(hidden);
	});

	test("filters persisted transcript entries without altering their roles, contents or model context", async () => {
		const harness = await createHarness({ persistedSession: true, settings: { hideCoordinationMessages: true } });
		harnesses.push(harness);
		for (const message of messages) {
			if (message.role === "custom")
				harness.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display);
			else if (message.role === "user") harness.sessionManager.appendMessage(message);
			else throw new Error(`Unexpected coordination fixture role: ${message.role}`);
		}
		const entries = harness.sessionManager.buildContextEntries();
		const saved = JSON.stringify(entries);
		const context = JSON.stringify(harness.sessionManager.buildSessionContext().messages);
		const { view } = createView(harness);
		view.renderSessionEntries(entries);
		expect(render(view.chatContainer)).toBe("");
		expect(JSON.stringify(entries)).toBe(saved);
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toBe(context);
		harness.sessionManager.appendMessage(fauxAssistantMessage("handled"));
		const restored = SessionManager.open(harness.sessionManager.getSessionFile()!);
		expect(
			restored
				.buildSessionContext()
				.messages.filter((message) => message.role !== "assistant")
				.map(getMessageText),
		).toEqual(messages.map(getMessageText));
	});

	test.each([false, true])(
		"actual mailbox and shared-channel delivery preserve acceptance, cursor and context with hiding=%s",
		async (hidden) => {
			const contexts: string[][] = [];
			const harness = await createHarness({
				persistedSession: true,
				settings: { hideCoordinationMessages: hidden },
				extensionFactories: [
					(pi) =>
						pi.on("context", (event) => {
							contexts.push(event.messages.map(getMessageText));
						}),
				],
			});
			harnesses.push(harness);
			const { view } = createView(harness);
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "custom"))
					view.addMessageToChat(event.message);
			});
			const db = getControlDbPath(harness.tempDir);
			const recipient = { sessionId: harness.session.sessionId, agentId: null };
			for (const [index, body] of [mailbox.body, "Broadcast: restart /tmp/pi"].entries()) {
				const messageId = `notice-${index}`;
				const sessionPath = "/tmp/sender.jsonl";
				upsertMultiAgentMailboxMessage(db, sessionPath, messageId, {
					id: messageId,
					fromAgentId: "worker",
					toAgentId: "main",
					kind: "message",
					body,
					status: "pending",
				});
				enqueueRuntimeMailboxMessage(db, {
					sender: mailbox.sender,
					recipient,
					kind: "message",
					storeRef: { sessionPath, messageId },
				});
			}
			const channelId = postSharedChannelMessage(db, {
				sender: { sessionId: "sender-session", agentId: null },
				body: "Release /tmp/shared",
			});
			harness.setResponses([fauxAssistantMessage("mailbox handled"), fauxAssistantMessage("channel handled")]);
			await harness.session.drainRuntimeCoordination();
			expect(listRuntimeMailboxMessages(db)).toEqual([]);
			expect(readSharedChannelCursor(db, recipient)).toBe(channelId);
			const delivered = harness.session.messages.filter(
				(message) => message.role === "user" || message.role === "custom",
			);
			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toMatchObject({ role: "user", inputSource: "extension" });
			expect(delivered[1]).toMatchObject({ role: "custom", customType: "shared_channel", display: true });
			expect(contexts.at(-1)?.join("\n")).toContain("child failed: owner exited");
			expect(contexts.at(-1)?.join("\n")).toContain("Release /tmp/shared");
			const restored = SessionManager.open(harness.sessionManager.getSessionFile()!);
			expect(restored.buildSessionContext().messages.map(getMessageText)).toEqual(
				harness.session.messages.map(getMessageText),
			);
			if (hidden) expect(render(view.chatContainer)).toBe("");
			else {
				expect(render(view.chatContainer)).toContain("child failed: owner exited");
				expect(render(view.chatContainer)).toContain("Broadcast: restart");
				expect(render(view.chatContainer)).toContain("Release /tmp/shared");
			}
		},
	);

	test("queue-update preview preserves typed envelopes and unrelated extension input while delivery and context stay complete", async () => {
		const seenContexts: string[][] = [];
		const harness = await createHarness({
			settings: { hideCoordinationMessages: true },
			extensionFactories: [
				(pi) =>
					pi.on("context", (event) => {
						seenContexts.push(event.messages.map(getMessageText));
					}),
			],
		});
		harnesses.push(harness);
		const { view, openSettings } = createView(harness);
		const previews: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") {
				view.updatePendingMessagesDisplay();
				previews.push(render(view.pendingMessagesContainer));
			}
		});
		const queuedSession = harness.session as unknown as {
			_queueFollowUp(text: string, images: undefined, source: "extension"): Promise<void>;
			_queueSteer(text: string, images: undefined, source: "extension"): Promise<void>;
		};
		await queuedSession._queueFollowUp(mailboxText, undefined, "extension");
		expect(previews.at(-1)).toBe("");
		await harness.session.followUp(mailboxText);
		expect(previews.at(-1)?.match(/child failed/g)).toHaveLength(1);
		await queuedSession._queueFollowUp("Unrelated extension error", undefined, "extension");
		const internals = harness.session as unknown as {
			_sendSharedChannelPrompt(text: string, options: { triggerIfIdle: boolean }): Promise<boolean>;
		};
		await internals._sendSharedChannelPrompt(sharedText, { triggerIfIdle: false });
		expect(previews.at(-1)).not.toContain("Release /tmp/shared");
		expect(previews.at(-1)).toContain("Unrelated extension error");
		expect(harness.session.getFollowUpMessages()).toEqual([
			mailboxText,
			mailboxText,
			"Unrelated extension error",
			sharedText,
		]);
		const snapshot = harness.session.getQueuedMessagePreviews();
		expect(snapshot.followUp[0]).toMatchObject({ text: mailboxText, inputSource: "extension" });
		expect(snapshot.followUp[3]).toMatchObject({ text: sharedText, customType: "shared_channel" });
		Object.assign(snapshot.followUp[0]!, { text: "mutated snapshot" });
		expect(harness.session.getFollowUpMessages()[0]).toBe(mailboxText);
		const steered = formatRuntimeMailboxPrompt(
			{ ...mailbox, body: "child failed: steered owner exited" },
			"recipient-session",
		);
		await queuedSession._queueSteer(steered, undefined, "extension");
		expect(previews.at(-1)).not.toContain("Steering:");
		const selector = openSettings();
		toggle(selector);
		expect(render(view.pendingMessagesContainer)).toContain("Release /tmp/shared");
		expect(render(view.pendingMessagesContainer)).toContain("Steering: From:");
		toggle(selector);
		expect(render(view.pendingMessagesContainer)).not.toContain("Release /tmp/shared");
		expect(render(view.pendingMessagesContainer)).not.toContain("Steering:");
		expect(harness.session.getSteeringMessages()).toEqual([steered]);
		harness.setResponses(Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`handled ${index}`)));
		await harness.session.prompt("start");
		expect(harness.session.messages.map(getMessageText)).toContain(sharedText);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "user" && getMessageText(message) === mailboxText,
			),
		).toHaveLength(2);
		expect(seenContexts.at(-1)).toEqual(
			expect.arrayContaining([mailboxText, "Unrelated extension error", sharedText]),
		);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});

	test("compaction previews and dequeue retain literal typed input regardless of coordination visibility", async () => {
		const harness = await createHarness({ settings: { hideCoordinationMessages: true } });
		harnesses.push(harness);
		const { view } = createView(harness);
		const internals = view as unknown as {
			compactionQueuedMessages: Array<{ mode: "steer" | "followUp"; text: string }>;
		};
		internals.compactionQueuedMessages = [{ mode: "followUp", text: mailboxText }];
		await harness.session.followUp(broadcastText);
		view.updatePendingMessagesDisplay();
		expect(render(view.pendingMessagesContainer)).toContain("child failed: owner exited");
		expect(render(view.pendingMessagesContainer)).toContain("Broadcast: restart");
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [broadcastText] });
		expect(internals.compactionQueuedMessages).toEqual([{ mode: "followUp", text: mailboxText }]);
		expect(harness.session.getQueuedMessagePreviews()).toEqual({ steering: [], followUp: [] });
	});
});
