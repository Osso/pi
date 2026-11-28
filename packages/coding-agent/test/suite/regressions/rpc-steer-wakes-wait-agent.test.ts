import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

// pi-desktop steers a server worker through RPC `prompt` with streamingBehavior "steer". The TUI woke an active
// wait_agent on steering_message_queued, RPC mode did not: the steer waited up to the 25-minute wait slice.
it("an RPC steer wakes a running wait_agent so the main agent reads it at once", async () => {
	await withHeadlessPi(async (pi) => {
		expect(await pi.send({ type: "prompt", message: "Spawn a worker and wait" })).toMatchObject({ success: true });
		const initial = await pi.waitForLlmRequest((request) => request.agentId === null);
		pi.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(fauxToolCall("spawn_agent", { prompt: "Keep working", context: "fresh" }), {
				stopReason: "toolUse",
			}),
		);
		// The child's model request stays unanswered, so the child keeps running.
		await pi.waitForLlmRequest((request) => request.agentId !== null);
		const afterSpawn = await pi.waitForLlmRequest((request) => request.agentId === null && request.id !== initial.id);
		pi.respondToLlmRequest(
			afterSpawn.id,
			fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
		);
		await pi.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "wait_agent");

		const steer = "Stop waiting and look at the nginx config instead.";
		expect(await pi.send({ type: "prompt", message: steer, streamingBehavior: "steer" })).toMatchObject({
			success: true,
		});
		const woken = await pi.waitForLlmRequest(
			(request) => request.agentId === null && request.userMessages.some((text) => text.includes(steer)),
			20_000,
		);
		expect(JSON.stringify(woken.messages)).toContain("Woken after supervisor steering.");
	});
}, 90_000);
