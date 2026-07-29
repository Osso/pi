import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

it("automatically continues the restored session after restart_self", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Restart and then continue automatically" });
		const beforeRestart = await pi.waitForLlmRequest((request) => request.agentId === null);

		pi.respondToLlmRequest(
			beforeRestart.id,
			fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
		);

		const afterRestart = await pi.waitForLlmRequest((request) => request.agentId === null, 10_000);
		expect(afterRestart.sessionId).toBe(pi.sessionId);
		expect(JSON.stringify(afterRestart.messages)).not.toContain("Continue from the restored session after restart.");
		const restoredEntries = pi.readSessionEntries(null);
		expect(
			restoredEntries.filter(
				(entry) => entry.type === "custom_message" && entry.customType === "self_restart",
			),
		).toHaveLength(1);
		expect(
			restoredEntries.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);

		pi.respondToLlmRequest(afterRestart.id, fauxAssistantMessage("continued"));
		await pi.waitForSessionEntry(
			null,
			(entry) => entry.type === "message" && JSON.stringify(entry.message).includes("continued"),
		);
	});
}, 30_000);
