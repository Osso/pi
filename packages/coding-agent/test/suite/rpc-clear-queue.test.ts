import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

describe("clear_queue over RPC", () => {
	it("returns and removes queued follow-up messages, which are then never delivered", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "start working" });
			const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			await agent.send({ type: "prompt", message: "then summarize", streamingBehavior: "followUp" });
			await agent.waitForEvent(
				(event) => event.type === "queue_update" && event.followUp.includes("then summarize"),
			);

			const cleared = await agent.send({ type: "clear_queue" });
			expect(cleared).toMatchObject({
				success: true,
				command: "clear_queue",
				data: { steering: [], followUp: ["then summarize"] },
			});
			await agent.waitForEvent(
				(event) => event.type === "queue_update" && event.steering.length === 0 && event.followUp.length === 0,
			);

			agent.respondToLlmRequest(
				request.id,
				fauxAssistantMessage([{ type: "text", text: "Done." }, fauxToolCall("end_turn", { reason: "Done" })], {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_settled");
			const state = await agent.send({ type: "get_state" });
			expect(state).toMatchObject({ data: { pendingMessageCount: 0 } });
			const messages = await agent.send({ type: "get_messages" });
			expect(JSON.stringify(messages)).not.toContain("then summarize");
		});
	}, 60_000);
});
