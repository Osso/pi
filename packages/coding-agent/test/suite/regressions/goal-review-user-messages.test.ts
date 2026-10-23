import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { enqueueStoredRuntimeMailboxMessage, getControlDbPath } from "../../../src/core/session-control-db.ts";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const ANSWER = "User answered questions (request deploy-scope):\n- What should deploy.sh do? → Install only";

/** The inbox reply a nonblocking ask_questions call enqueues once the user answers. */
function enqueueQueuedAnswer(agent: HeadlessPi): void {
	const messageId = "ask_questions:deploy-scope";
	const self = { sessionId: agent.sessionId, agentId: null };
	enqueueStoredRuntimeMailboxMessage(getControlDbPath(agent.paths.agentDir), {
		kind: "reply",
		recipient: self,
		sender: self,
		storeRef: { sessionPath: agent.sessionFile, messageId },
		message: {
			id: messageId,
			kind: "reply",
			fromAgentId: "main",
			toAgentId: "main",
			status: "pending",
			body: ANSWER,
			createdAt: new Date().toISOString(),
		},
	});
}

// Observed: a request, a steered follow-up, and a nonblocking question answer reached the goal
// review as only the follow-up; the first request and the answer were reported as unsupported.
it("sends every user message and the inbox question answer to goal review", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "let's add hotplug" });
		const first = await agent.waitForLlmRequest();
		await agent.send({ type: "prompt", message: "also we need rfkill", streamingBehavior: "steer" });
		enqueueQueuedAnswer(agent);
		// The steered follow-up and the inbox answer may reach the model in separate requests.
		const answered = new Set<string>();
		let withAnswer = first;
		while (!withAnswer.userMessages.some((text) => text.includes("Install only"))) {
			agent.respondToLlmRequest(withAnswer.id, fauxAssistantMessage("Noted."));
			answered.add(withAnswer.id);
			withAnswer = await agent.waitForLlmRequest((request) => !answered.has(request.id));
		}
		expect(withAnswer.userMessages.join("\n")).toContain("also we need rfkill");
		agent.respondToLlmRequest(
			withAnswer.id,
			fauxAssistantMessage(fauxToolCall("manage_goal", { action: "set", objective: "Add deploy.sh" }), {
				stopReason: "toolUse",
			}),
		);

		const review = await agent.waitForSupervisorRequest("goal_set_review");
		expect(review.payload.userMessages).toEqual(["let's add hotplug", "also we need rfkill", ANSWER]);
		agent.respondToSupervisorRequest(review, {
			kind: "set",
			objective: "Add hotplug, rfkill, and an install-only deploy.sh",
			reason: "All three come from user messages.",
		});
		answered.add(withAnswer.id);
		await agent.waitForLlmRequest((request) => !answered.has(request.id));
		await agent.send({ type: "abort" });
	});
}, 60_000);
