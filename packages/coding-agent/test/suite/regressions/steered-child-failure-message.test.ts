import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";
import { spawnFreshAgentFromMain } from "../headless-spawn.ts";

const PROVIDER_ERROR = 'OpenAI API error (400): {"message":"invalid_request_error: unsupported input"}';

function fauxCompletedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

// 2026-11-17, agent-server: four steered children failed at once and the parent saw only
// "Runtime mailbox steering turn failed"; the provider error that ended each turn was dropped.
it("records the provider error when a steered child turn fails", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Start a child, then steer it" });
		const mainRequest = await spawnFreshAgentFromMain(pi, "Steered failure target", "Wait for steering");
		const spawned = await pi.waitForAgent((agent) => agent.displayName === "Steered failure target");
		const initialChildRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
		const mainAfterSpawn = await pi.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== mainRequest.id,
		);
		pi.respondToLlmRequest(
			mainAfterSpawn.id,
			fauxAssistantMessage(fauxToolCall("steer_agent", { agentId: spawned.id, message: "Apply this steering" }), {
				stopReason: "toolUse",
			}),
		);
		await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "steering_pending");
		pi.respondToLlmRequest(initialChildRequest.id, fauxCompletedAssistantMessage("Initial child turn complete"));
		const steeredRequest = await pi.waitForLlmRequest(
			(request) => request.agentId === spawned.id && request.id !== initialChildRequest.id,
		);

		pi.respondToLlmRequest(
			steeredRequest.id,
			fauxAssistantMessage([], { stopReason: "error", errorMessage: PROVIDER_ERROR }),
		);

		const failed = await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "failed");
		expect(failed.error?.message).toBe(PROVIDER_ERROR);
	});
});
