import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

const QUEUED_MESSAGE = "Queued message that must not run after close";

function fauxCompletedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

describe("close_agent with a queued agent message", () => {
	it("does not start a new child turn from the message after the close aborts the child", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Spawn a worker, message it, then close it" });
			const initialMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialMainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", { context: "fresh", displayName: "Closed worker", prompt: "Start work" }),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Closed worker");
			// The child's first model request stays unanswered, so the child is mid-turn when it is closed.
			await agent.waitForLlmRequest((request) => request.agentId === spawned.id);

			const mainAfterSpawn = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMainRequest.id,
			);
			agent.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(fauxToolCall("send_agent_message", { toAgentId: spawned.id, body: QUEUED_MESSAGE }), {
					stopReason: "toolUse",
				}),
			);

			const mainAfterMessage = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && request.id !== initialMainRequest.id && request.id !== mainAfterSpawn.id,
			);
			agent.respondToLlmRequest(
				mainAfterMessage.id,
				fauxAssistantMessage(fauxToolCall("close_agent", { agentId: spawned.id }), { stopReason: "toolUse" }),
			);
			await agent.waitForAgent((candidate) => candidate.id === spawned.id && candidate.lifecycle === "aborted");
			const mainAfterClose = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.id !== initialMainRequest.id &&
					request.id !== mainAfterSpawn.id &&
					request.id !== mainAfterMessage.id,
			);
			agent.respondToLlmRequest(mainAfterClose.id, fauxCompletedAssistantMessage("Worker closed"));

			await expect(
				agent.waitForLlmRequest(
					(request) =>
						request.agentId === spawned.id &&
						request.userMessages.some((message) => message.includes(QUEUED_MESSAGE)),
					2_000,
				),
			).rejects.toThrow();
			const childUserMessages = agent
				.readSessionEntries(spawned.id)
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map((entry) => JSON.stringify(entry));
			expect(childUserMessages.filter((entry) => entry.includes(QUEUED_MESSAGE))).toEqual([]);
			expect(agent.listAgents().find((candidate) => candidate.id === spawned.id)?.lifecycle).toBe("aborted");
		});
	});
});
