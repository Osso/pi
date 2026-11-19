import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

const LOOP_PROMPT = "Inspect the current work once.";

it("continues a loop turn that /restart interrupted before the model answered", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: `/loop 1s ${LOOP_PROMPT}` });
		await pi.waitForLlmRequest(
			(request) => request.agentId === null && JSON.stringify(request.messages).includes(LOOP_PROMPT),
		);

		// The process execs in place before answering, so this RPC response never arrives. Only requests after the
		// restart carry its notice; request IDs restart with the process.
		void pi.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
		const continued = await pi.waitForLlmRequest(
			(request) =>
				request.agentId === null && JSON.stringify(request.messages).includes("The agent process was restarted"),
			10_000,
		);

		expect(continued.sessionId).toBe(pi.sessionId);
		expect(JSON.stringify(continued.messages).split(LOOP_PROMPT)).toHaveLength(2);
		pi.respondToLlmRequest(
			continued.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Loop turn resumed" }), { stopReason: "toolUse" }),
		);
		await pi.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
		);
	});
}, 60_000);
