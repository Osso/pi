import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

it("does not carry hook messages from a restored terminal-tool continuation into the next prompt", async () => {
	let hookRun = 0;
	const providerRequests: string[][] = [];
	harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => ({
					message: {
						customType: "run-context",
						content: `run-context-${++hookRun}`,
						display: false,
					},
				}));
			},
		],
	});
	harness.sessionManager.appendMessage({ role: "user", content: "restored request", timestamp: 1 });
	harness.sessionManager.appendMessage(
		fauxAssistantMessage(
			[{ type: "text", text: "Restored answer" }, fauxToolCall("end_turn", { reason: "Already complete" })],
			{ stopReason: "toolUse" },
		),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	harness.setResponses([
		(context) => {
			providerRequests.push(context.messages.map(getMessageText));
			return fauxAssistantMessage("done");
		},
	]);

	await harness.session.continue();
	await harness.session.agent.waitForIdle();

	const providerRequestCountAfterContinue = providerRequests.length;
	const hasQueuedMessagesAfterContinue = harness.session.agent.hasQueuedMessages();

	await harness.session.prompt("Unrelated new request");

	const persistedHookMessages = harness.session.messages
		.filter((message) => message.role === "custom" && message.customType === "run-context")
		.map(getMessageText);
	expect({
		providerRequestCountAfterContinue,
		hasQueuedMessagesAfterContinue,
		providerRequests: providerRequests.map((request) => request.filter((text) => text.startsWith("run-context-"))),
		persistedHookMessages,
	}).toEqual({
		providerRequestCountAfterContinue: 0,
		hasQueuedMessagesAfterContinue: false,
		providerRequests: [["run-context-2"]],
		persistedHookMessages: ["run-context-2"],
	});
});
