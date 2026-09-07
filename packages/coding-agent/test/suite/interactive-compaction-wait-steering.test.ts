import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const steeringText = "is that the only table needing updates? what happened to the other parallel workers?";

function createGate() {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function completedTurn() {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" });
}

function createEditorFixture(harness: Harness, wake: () => void) {
	const fixture = {
		session: harness.session,
		isInitialized: true,
		isBashMode: false,
		defaultEditor: {} as { onSubmit?: (text: string) => Promise<void>; onEscape?: () => void },
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		options: { wakeWaitAgentsAfterSteering: wake },
		compactionQueuedMessages: [] as Array<{ text: string; mode: "steer" | "followUp" }>,
		pendingUserInputs: [] as string[],
		closeResponseCompleteNotification: vi.fn(),
		submitSelectedAgentSteering: async () => false,
		handleHiddenMainSessionDisplayEvent: () => false,
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		setPromptActivity: vi.fn(),
		syncWorkingLoaderVisibility: vi.fn(),
		rebuildChatAfterCompaction: vi.fn(),
		footer: { invalidate: vi.fn() },
		settingsManager: harness.settingsManager,
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		addSubmittedTextToHistory: (text: string): void => {
			fixture.editor.addToHistory(text);
		},
		isExtensionCommand: (text: string): boolean => methods.isExtensionCommand.call(fixture, text),
		queueCompactionMessage: (text: string, mode: "steer" | "followUp"): void =>
			methods.queueCompactionMessage.call(fixture, text, mode),
		deliverCompactionMessage: (message: { text: string; mode: "steer" | "followUp" }): Promise<void> =>
			methods.deliverCompactionMessage.call(fixture, message),
		flushCompactionQueue: (options?: { willRetry?: boolean }): Promise<void> =>
			methods.flushCompactionQueue.call(fixture, options),
	};
	return fixture;
}

type EditorFixture = ReturnType<typeof createEditorFixture>;
const methods = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: EditorFixture): void;
	handleEvent(this: EditorFixture, event: AgentSessionEvent): Promise<void>;
	isExtensionCommand(this: EditorFixture, text: string): boolean;
	queueCompactionMessage(this: EditorFixture, text: string, mode: "steer" | "followUp"): void;
	deliverCompactionMessage(this: EditorFixture, message: { text: string; mode: "steer" | "followUp" }): Promise<void>;
	flushCompactionQueue(this: EditorFixture, options?: { willRetry?: boolean }): Promise<void>;
};

async function startScenario() {
	const thinkingStarted = createGate();
	const thinkingRelease = createGate();
	const compactionStarted = createGate();
	const compactionRelease = createGate();
	const waitStarted = createGate();
	const waitRelease = createGate();
	let deliveredUserTexts: string[] = [];
	const waitTool: AgentTool = {
		name: "wait_agent",
		label: "Wait",
		description: "Wait until steering wakes this tool",
		parameters: Type.Object({}),
		async execute() {
			waitStarted.release();
			await waitRelease.promise;
			return { content: [{ type: "text", text: "Woken after supervisor steering." }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [waitTool],
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("compaction", async (event) => {
					compactionStarted.release();
					await compactionRelease.promise;
					return {
						compaction: {
							summary: "Earlier work summarized",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	harness.setResponses([
		completedTurn(),
		async () => {
			thinkingStarted.release();
			await thinkingRelease.promise;
			return completedTurn();
		},
		fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
		(context) => {
			deliveredUserTexts = context.messages.filter((message) => message.role === "user").map(getMessageText);
			return completedTurn();
		},
	]);
	await harness.session.prompt("Earlier work");
	const running = harness.session.prompt("Continue working");
	await thinkingStarted.promise;
	const compacting = harness.session.compact();
	await compactionStarted.promise;
	const fixture = createEditorFixture(harness, waitRelease.release);
	methods.setupEditorSubmitHandler.call(fixture);
	const eventTasks: Promise<void>[] = [];
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "steering_message_queued" || event.type === "compaction_end") {
			eventTasks.push(methods.handleEvent.call(fixture, event));
		}
	});
	return {
		harness,
		fixture,
		compactionRelease,
		waitStarted,
		readDeliveredTexts: () => deliveredUserTexts,
		async cleanup() {
			thinkingRelease.release();
			compactionRelease.release();
			waitRelease.release();
			try {
				await Promise.all([running, compacting, ...eventTasks]);
			} finally {
				unsubscribe();
				harness.cleanup();
			}
		},
	};
}

it.each(["during compaction", "during resumed wait"] as const)(
	"delivers actual editor steering %s through the wait wake path",
	async (timing) => {
		const scenario = await startScenario();
		const { fixture, harness } = scenario;
		try {
			if (timing === "during resumed wait") {
				scenario.compactionRelease.release();
				await scenario.waitStarted.promise;
			}
			const submission = fixture.defaultEditor.onSubmit?.(steeringText);
			if (timing === "during compaction") {
				await submission;
				expect(harness.session.isCompacting).toBe(true);
				expect(fixture.compactionQueuedMessages).toEqual([{ text: steeringText, mode: "steer" }]);
				expect(harness.session.pendingMessageCount).toBe(0);
				scenario.compactionRelease.release();
			}
			await expect.poll(() => scenario.readDeliveredTexts().includes(steeringText), { timeout: 1_000 }).toBe(true);
			await submission;
			expect(scenario.readDeliveredTexts().filter((text) => text === steeringText)).toHaveLength(1);
			expect(getUserTexts(harness).filter((text) => text === steeringText)).toHaveLength(1);
			expect(fixture.compactionQueuedMessages).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(fixture.showError).not.toHaveBeenCalled();
		} finally {
			await scenario.cleanup();
		}
	},
);
