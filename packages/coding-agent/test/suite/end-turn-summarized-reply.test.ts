import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { SUMMARIZED_REPLY_ERROR } from "../../src/core/tools/end-turn.ts";
import { withHeadlessPi } from "./headless-pi.ts";

// Signature envelope as Anthropic returns it: field 2 -> field 1 -> field 8 holds the block kind.
function blockSignature(kind: string): string {
	const field = (tag: number, payload: Buffer) => Buffer.concat([Buffer.from([tag, payload.length]), payload]);
	const header = Buffer.concat([Buffer.from([0x08, 0x12, 0x18, 0x02, 0x38, 0x01]), field(0x42, Buffer.from(kind))]);
	return Buffer.concat([Buffer.from([0x08, 0x04]), field(0x12, field(0x0a, header))]).toString("base64");
}

const narration = {
	type: "thinking" as const,
	thinking: "I explained how the relay spawns ssh and outlined a dedicated relay key.",
	thinkingSignature: blockSignature("narration"),
};

it("rejects end_turn when the reply was replaced by a server narration summary, then accepts the rewritten reply", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "How does the relay run ssh?" });
		let request = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(
			request.id,
			fauxAssistantMessage([narration, fauxToolCall("end_turn", { reason: "Explained relay ssh" })], {
				stopReason: "toolUse",
			}),
		);

		const firstId = request.id;
		request = await agent.waitForLlmRequest((candidate) => candidate.id !== firstId);
		agent.respondToLlmRequest(request.id, fauxAssistantMessage("The relay spawns ssh with BatchMode=yes."));

		const secondId = request.id;
		request = await agent.waitForLlmRequest((candidate) => candidate.id !== secondId);
		agent.respondToLlmRequest(
			request.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Explained relay ssh" }), { stopReason: "toolUse" }),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");

		const results = agent
			.readSessionEntries(null)
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn"
					? [entry.message]
					: [],
			);
		expect(results.map((result) => result.isError)).toEqual([true, false]);
		expect(results[0].content).toEqual([{ type: "text", text: SUMMARIZED_REPLY_ERROR }]);
	});
}, 60_000);

it("keeps end_turn terminal when its response carries ordinary thinking and no text", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Nothing to say" });
		const request = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(
			request.id,
			fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "No reply needed.", thinkingSignature: blockSignature("thinking") },
					fauxToolCall("end_turn", { reason: "No reply requested" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");
		const results = agent
			.readSessionEntries(null)
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn"
					? [entry.message]
					: [],
			);
		expect(results.map((result) => result.isError)).toEqual([false]);
	});
}, 60_000);
