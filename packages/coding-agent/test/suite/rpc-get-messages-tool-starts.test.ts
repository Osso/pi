import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

type Messages = { messages: Array<Record<string, unknown>>; toolCallStarts: Record<string, number> };

describe("RPC get_messages toolCallStarts", () => {
	it("reports when each tool call started, after its assistant message streamed", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Run one command" });
			const first = await agent.waitForLlmRequest((request) => request.agentId === null);
			const beforeReply = Date.now();
			agent.respondToLlmRequest(
				first.id,
				fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1" }), { stopReason: "toolUse" }),
			);
			const second = await agent.waitForLlmRequest((request) => request.agentId === null && request.id !== first.id);
			agent.respondToLlmRequest(
				second.id,
				fauxAssistantMessage([{ type: "text", text: "Ran it." }, fauxToolCall("end_turn", { reason: "done" })], {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_end");
			const { data } = (await agent.send({ type: "get_messages" })) as unknown as { data: Messages };
			const bash = data.messages
				.flatMap((message) =>
					message.role === "assistant" ? (message.content as Array<Record<string, unknown>>) : [],
				)
				.find((block) => block.type === "toolCall" && block.name === "bash");
			const result = data.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === bash?.id,
			);
			const start = data.toolCallStarts[bash?.id as string];
			expect(start).toBeGreaterThanOrEqual(beforeReply - 50);
			// The command slept a second: its result arrived about a second after the start.
			expect((result?.timestamp as number) - start).toBeGreaterThanOrEqual(900);
		});
	});
});
