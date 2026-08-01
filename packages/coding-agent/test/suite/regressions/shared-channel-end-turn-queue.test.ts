import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	getControlDbPath,
	initializeSharedChannelCursorAtTail,
	postSharedChannelMessage,
} from "../../../src/core/session-control-db.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function fauxEndTurn(reason: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" });
}

describe("shared-channel follow-up queue", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("clears the pending preview when shared-channel work starts after end_turn", async () => {
		const harness = await createHarness({ initialActiveToolNames: ["end_turn"], persistedSession: true });
		harnesses.push(harness);
		const controlDbPath = getControlDbPath(harness.tempDir);
		await harness.session.bindExtensions({ controlDbPath });
		const recipient = { agentId: null, sessionId: harness.sessionManager.getSessionId() };
		initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		const sharedBody = "Installed runtime changed; restart this session.";
		postSharedChannelMessage(controlDbPath, {
			body: sharedBody,
			sender: { agentId: null, sessionId: "deployment-session" },
		});

		let sharedPrompt = "";
		harness.setResponses([
			fauxEndTurn("Initial work finished."),
			fauxEndTurn("Continuation settled before the queued follow-up."),
			(context) => {
				const sharedMessage = context.messages.find((message) => getMessageText(message).includes(sharedBody));
				sharedPrompt = getMessageText(sharedMessage);
				return fauxEndTurn("Shared-channel follow-up processed.");
			},
		]);

		await harness.session.prompt("Finish the current task.");

		expect(sharedPrompt).toContain(sharedBody);
		expect(harness.eventsOfType("queue_update")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ followUp: [expect.stringContaining(sharedBody)] }),
				expect.objectContaining({ followUp: [] }),
			]),
		);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});
