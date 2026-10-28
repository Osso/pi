import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getMessageText } from "../harness.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

it("rejects messages to a completed direct child without queueing them", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Start a worker" });
		const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Closed worker",
					prompt: "Complete the work",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await agent.waitForAgent((candidate) => candidate.displayName === "Closed worker");
		const childSessionId = requireHeadlessAgentSessionId(child);
		const childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
		const parentRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			parentRequest.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Worker started" }), { stopReason: "toolUse" }),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");
		agent.respondToLlmRequest(
			childRequest.id,
			fauxAssistantMessage(
				[{ type: "text", text: "Work complete." }, fauxToolCall("end_turn", { reason: "Work complete" })],
				{ stopReason: "toolUse" },
			),
		);
		await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		const completion = await agent.waitForLlmRequest(
			(request) =>
				request.agentId === null && request.userMessages.some((text) => text.includes("Closed worker completed")),
		);
		const before = agent.listMailboxMessages().length;
		const runtimeBefore = agent.listRuntimeMailboxMessages().length;
		let requestId = completion.id;
		for (const [id, toSessionId] of [
			["closed-direct", undefined],
			["closed-session", childSessionId],
		] as const) {
			agent.respondToLlmRequest(
				requestId,
				fauxAssistantMessage(
					fauxToolCall(
						"send_agent_message",
						{ toAgentId: child.id, ...(toSessionId ? { toSessionId } : {}), body: id },
						{ id },
					),
					{ stopReason: "toolUse" },
				),
			);
			const next = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.messages.some((message) => message.role === "toolResult" && message.toolCallId === id),
			);
			const result = next.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
			expect(result).toMatchObject({ isError: true });
			expect(getMessageText(result)).toContain("agent is closed; use attach_session_agent");
			expect(agent.listMailboxMessages()).toHaveLength(before);
			expect(agent.listRuntimeMailboxMessages()).toHaveLength(runtimeBefore);
			requestId = next.id;
		}
		agent.respondToLlmRequest(
			requestId,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" }),
		);
	});
}, 60_000);
