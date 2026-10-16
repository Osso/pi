import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getMessageText } from "../harness.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

it("delivers distinct explicit bodies from successive child responses in one user turn through a real Pi process", async () => {
	await withHeadlessPi(async (agent) => {
		const assignment = "Send two explicit reports in this user turn";
		const narration = "Narration only: I am contacting the parent, not sending these words";
		const firstBody = "\n  First explicit report: café/Étain;  spaces;\ttab; 雪.\n";
		const secondBody = "\n\tSecond explicit report: different body; λ/日本語.  \n";
		await agent.send({ type: "prompt", message: "Delegate two progress reports" });
		const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { context: "fresh", displayName: "Explicit body worker", prompt: assignment }),
				{ stopReason: "toolUse" },
			),
		);
		const child = await agent.waitForAgent((candidate) => candidate.displayName === "Explicit body worker");
		const childSessionId = requireHeadlessAgentSessionId(child);
		const firstChildRequest = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		expect(firstChildRequest.userMessages).toEqual([assignment]);
		const afterSpawn = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			firstChildRequest.id,
			fauxAssistantMessage(
				[{ type: "text", text: narration }, fauxToolCall("contact_parent", { body: firstBody })],
				{ stopReason: "toolUse" },
			),
		);
		const childContinuation = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		expect(childContinuation.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "contact_parent", isError: false }),
		);

		// The parent was already streaming when contact_parent notified it. Finish that response first.
		agent.respondToLlmRequest(
			afterSpawn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Worker started" }), { stopReason: "toolUse" }),
		);
		const firstEnvelope = [
			"From:",
			`- session: ${childSessionId}`,
			`- agent: ${child.id}`,
			"",
			"Message:",
			firstBody,
		].join("\n");
		const firstNotification = await agent.waitForLlmRequest(
			(request) => request.agentId === null && request.userMessages.includes(firstEnvelope),
		);
		expect(firstNotification.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "end_turn", isError: false }),
		);
		expect(firstNotification.userMessages.filter((text) => text === firstEnvelope)).toHaveLength(1);
		expect(firstNotification.userMessages.join("\n")).not.toContain(narration);

		agent.respondToLlmRequest(
			childContinuation.id,
			fauxAssistantMessage(
				fauxToolCall("send_agent_message", { toAgentId: "main", toSessionId: agent.sessionId, body: secondBody }),
				{ stopReason: "toolUse" },
			),
		);
		const afterSecondSend = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		expect(afterSecondSend.userMessages).toEqual([assignment]);
		expect(afterSecondSend.messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", toolName: "send_agent_message", isError: false }),
		);

		// The second notification is queued behind the parent's first notification response.
		agent.respondToLlmRequest(
			firstNotification.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "First report received" }), { stopReason: "toolUse" }),
		);
		const secondEnvelope = [
			"From:",
			`- session: ${childSessionId}`,
			`- agent: ${child.id}`,
			"",
			"Message:",
			secondBody,
		].join("\n");
		const secondNotification = await agent.waitForLlmRequest(
			(request) => request.agentId === null && request.userMessages.includes(secondEnvelope),
		);
		for (const envelope of [firstEnvelope, secondEnvelope]) {
			expect(secondNotification.userMessages.filter((text) => text === envelope)).toHaveLength(1);
		}
		expect(secondNotification.userMessages.join("\n")).not.toContain(narration);
		const deliveredReports = agent
			.readSessionEntries(null)
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.map((entry) => (entry.type === "message" ? getMessageText(entry.message) : ""))
			.filter((text) => text.includes(`- session: ${childSessionId}`));
		expect(deliveredReports).toEqual([firstEnvelope, secondEnvelope]);
		agent.respondToLlmRequest(
			secondNotification.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Second report received" }), {
				stopReason: "toolUse",
			}),
		);
		await agent.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "end_turn" &&
				getMessageText(entry.message) === "Turn ended: Second report received",
		);
		agent.respondToLlmRequest(
			afterSecondSend.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Both reports sent" }), { stopReason: "toolUse" }),
		);
		await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		const completion = await agent.waitForLlmRequest(
			(request) =>
				request.agentId === null &&
				request.userMessages.some((text) => text.includes("Explicit body worker completed:")),
		);
		agent.respondToLlmRequest(
			completion.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Completion received" }), { stopReason: "toolUse" }),
		);
		await agent.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "end_turn" &&
				getMessageText(entry.message) === "Turn ended: Completion received",
		);
	});
}, 30_000);
