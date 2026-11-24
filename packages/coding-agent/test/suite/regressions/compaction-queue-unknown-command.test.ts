import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

let harness: Harness | undefined;
beforeAll(() => initTheme("dark"));
afterEach(() => harness?.cleanup());

it("delivers queued steering after an unknown slash command queued during compaction", async () => {
	harness = await createHarness();
	harness.setResponses([fauxAssistantMessage("steering answered")]);
	const showError = vi.fn();
	const view = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		compactionQueuedMessages: [
			{ text: "/does-not-exist hello", mode: "steer" },
			{ text: "what happened to the other parallel workers?", mode: "steer" },
		],
		pendingMessagesContainer: new Container(),
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		showError,
		showStatus: () => {},
	}) as { flushCompactionQueue(): Promise<void>; compactionQueuedMessages: unknown[] };

	await view.flushCompactionQueue();
	await vi.waitFor(() => expect(showError).toHaveBeenCalled());
	await harness.session.agent.waitForIdle();

	expect(showError).toHaveBeenCalledTimes(1);
	expect(showError.mock.calls[0]?.[0]).toContain("Unknown slash command: /does-not-exist");
	const userTexts = harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => JSON.stringify(message.content));
	expect(userTexts.join("\n")).toContain("what happened to the other parallel workers?");
	expect(view.compactionQueuedMessages).toEqual([]);
});

it("starts an Alt+Enter follow-up after an unknown slash command is rejected during compaction", async () => {
	harness = await createHarness({ noSupervisor: true });
	const followUpText = "Review the change";
	const providerRequests: string[][] = [];
	harness.setResponses([
		(context) => {
			providerRequests.push(context.messages.filter((message) => message.role === "user").map(getMessageText));
			return fauxAssistantMessage("follow-up answered");
		},
	]);
	const showError = vi.fn();
	const view = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		compactionQueuedMessages: [
			{ text: "/does-not-exist hello", mode: "steer" },
			{ text: followUpText, mode: "followUp" },
		],
		pendingMessagesContainer: new Container(),
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		showError,
		showStatus: () => {},
	}) as { flushCompactionQueue(): Promise<void>; compactionQueuedMessages: unknown[] };

	await view.flushCompactionQueue();
	await vi.waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
	await harness.session.agent.waitForIdle();

	expect(showError.mock.calls[0]?.[0]).toContain("Unknown slash command: /does-not-exist");
	expect(providerRequests).toEqual([[followUpText]]);
	expect(view.compactionQueuedMessages).toEqual([]);
});
