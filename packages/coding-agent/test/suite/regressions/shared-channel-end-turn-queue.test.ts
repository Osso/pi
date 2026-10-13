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

		const lastRequestMessages: string[] = [];
		harness.setResponses([
			(context) => {
				lastRequestMessages.push(getMessageText(context.messages.at(-1)));
				return fauxEndTurn("Initial work finished.");
			},
			(context) => {
				lastRequestMessages.push(getMessageText(context.messages.at(-1)));
				return fauxEndTurn("Shared-channel follow-up processed.");
			},
		]);

		await harness.session.prompt("Finish the current task.");

		// The queued channel message starts the next request; no request may resend the ended end_turn result.
		expect(lastRequestMessages).toHaveLength(2);
		expect(lastRequestMessages[1]).toContain(sharedBody);
		expect(harness.eventsOfType("queue_update")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ followUp: [expect.stringContaining(sharedBody)] }),
				expect.objectContaining({ followUp: [] }),
			]),
		);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});
