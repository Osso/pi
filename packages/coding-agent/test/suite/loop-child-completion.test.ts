import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

it("stops a completed production child's loop before disposing its extension context", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Delegate a recurring check" });
		const initial = await agent.waitForLlmRequest((request) => request.sessionId === agent.sessionId);
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(
				[
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Loop completion worker",
						prompt: "Start a recurring check, then finish immediately",
					}),
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Independent sibling",
						prompt: "Finish after the loop worker completes",
					}),
				],
				{ stopReason: "toolUse" },
			),
		);
		const child = await agent.waitForAgent((candidate) => candidate.displayName === "Loop completion worker");
		const sibling = await agent.waitForAgent((candidate) => candidate.displayName === "Independent sibling");
		const siblingRequest = await agent.waitForLlmRequest(
			(request) => request.sessionId === requireHeadlessAgentSessionId(sibling),
		);
		const childSessionId = requireHeadlessAgentSessionId(child);
		const childRequest = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		const loopPrompt = "This completed child's loop must never run";
		agent.respondToLlmRequest(
			childRequest.id,
			fauxAssistantMessage(fauxToolCall("loop", { action: "start", intervalSeconds: 1, prompt: loopPrompt }), {
				stopReason: "toolUse",
			}),
		);
		const afterStart = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		expect(
			agent
				.readSessionEntries(child.id)
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "loop" &&
						!entry.message.isError,
				),
		).toBe(true);
		agent.respondToLlmRequest(
			afterStart.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Child check complete" }), { stopReason: "toolUse" }),
		);
		await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		await delay(1_200);
		expect(await agent.send({ type: "get_state" })).toMatchObject({ success: true, command: "get_state" });
		agent.respondToLlmRequest(
			siblingRequest.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Sibling unaffected" }), { stopReason: "toolUse" }),
		);
		await agent.waitForAgent((candidate) => candidate.id === sibling.id && candidate.lifecycle === "completed");
		expect(
			agent
				.readSessionEntries(child.id)
				.filter((entry) => entry.type === "custom_message" && entry.customType === "loop"),
		).toHaveLength(0);
	});
}, 60_000);
