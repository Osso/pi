import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { createHarness, getMessageText } from "./harness.ts";
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

it("accepts end_turn alongside public signed narration without asking for a regenerated reply", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "How does the relay run ssh?" });
		const request = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(
			request.id,
			fauxAssistantMessage([narration, fauxToolCall("end_turn", { reason: "Explained relay ssh" })], {
				stopReason: "toolUse",
			}),
		);

		const result = await agent.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
		);
		if (result.type !== "message" || result.message.role !== "toolResult") throw new Error("Expected tool result");
		expect(result.message.isError).toBe(false);
		await agent.waitForEvent((event) => event.type === "agent_end");

		const results = agent
			.readSessionEntries(null)
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn"
					? [entry.message]
					: [],
			);
		expect(results.map((result) => result.isError)).toEqual([false]);
		const replies = agent
			.readSessionEntries(null)
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(replies).toHaveLength(1);
		expect(replies[0].content[0]).toEqual(narration);
	});
}, 60_000);

it("rejects a thinking-only end_turn, then ends after the model writes a visible reply", async () => {
	const harness = await createHarness();
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxThinking("Private reasoning."), fauxToolCall("end_turn", { reason: "Done" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[{ type: "text", text: "Visible answer." }, fauxToolCall("end_turn", { reason: "Answered" })],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.prompt("What is the answer?");

		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage<unknown> =>
				message.role === "toolResult" && message.toolName === "end_turn",
		);
		expect(results.map((result) => result.isError)).toEqual([true, false]);
		const firstResult = results[0];
		if (!firstResult || firstResult.role !== "toolResult") throw new Error("Expected rejected end_turn result");
		expect(getMessageText(firstResult)).toContain("Thinking is never shown");
		expect(
			harness.session.messages.some(
				(message) => message.role === "assistant" && getMessageText(message) === "Visible answer.",
			),
		).toBe(true);
	} finally {
		harness.cleanup();
	}
}, 60_000);

it("accepts end_turn when the branch has no user prompt", async () => {
	const harness = await createHarness();
	try {
		harness.session.agent.state.messages = [fauxAssistantMessage("Assistant-only history.")];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "No user prompt exists" }), {
				stopReason: "toolUse",
			}),
		]);

		await harness.session.continue();

		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage<unknown> =>
				message.role === "toolResult" && message.toolName === "end_turn",
		);
		expect(results.map((result) => result.isError)).toEqual([false]);
	} finally {
		harness.cleanup();
	}
}, 60_000);

it("accepts textless end_turn on a custom continuation after a visible reply", async () => {
	const harness = await createHarness();
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[{ type: "text", text: "Visible answer." }, fauxToolCall("end_turn", { reason: "Answered" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Supervisor continuation complete" }), {
				stopReason: "toolUse",
			}),
		]);

		await harness.session.prompt("What is the answer?");
		await harness.session.sendCustomMessage(
			{ customType: "supervisor-instruction", content: "Continue the prior work.", display: false },
			{ triggerTurn: true },
		);

		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage<unknown> =>
				message.role === "toolResult" && message.toolName === "end_turn",
		);
		expect(results.map((result) => result.isError)).toEqual([false, false]);
	} finally {
		harness.cleanup();
	}
}, 60_000);
