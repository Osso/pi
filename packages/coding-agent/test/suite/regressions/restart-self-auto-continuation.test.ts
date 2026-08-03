import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

async function persistCompletedEndTurn(pi: HeadlessPi): Promise<void> {
	await pi.send({ type: "prompt", message: "Finish this turn before process restart" });
	const request = await pi.waitForLlmRequest((candidate) => candidate.agentId === null);
	pi.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Turn completed before restart" }), {
			stopReason: "toolUse",
		}),
	);
	await pi.waitForSessionEntry(
		null,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
	);
}

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
			restoredEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "self_restart"),
		).toHaveLength(1);
		expect(restoredEntries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(
			1,
		);

		pi.respondToLlmRequest(afterRestart.id, fauxAssistantMessage("continued"));
		await pi.waitForSessionEntry(
			null,
			(entry) => entry.type === "message" && JSON.stringify(entry.message).includes("continued"),
		);
	});
}, 30_000);

it("keeps a completed turn idle after process restart without a running goal", async () => {
	await withHeadlessPi(async (pi) => {
		await persistCompletedEndTurn(pi);

		await pi.restart();

		await expect(pi.waitForLlmRequest((request) => request.agentId === null, 1_000)).rejects.toThrow(
			"Timed out waiting for LLM request",
		);
	});
}, 30_000);

it("continues a completed running goal after restart while a child remains live", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Spawn a child, then complete the main turn" });
		const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
		pi.respondToLlmRequest(
			mainRequest.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Resume policy child",
					prompt: "Wait across restart",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await pi.waitForAgent((agent) => agent.displayName === "Resume policy child");
		const initialChildRequest = await pi.waitForLlmRequest((request) => request.agentId === child.id);
		const mainAfterSpawn = await pi.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== mainRequest.id,
		);
		pi.respondToLlmRequest(
			mainAfterSpawn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Main turn completed" }), {
				stopReason: "toolUse",
			}),
		);
		await pi.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
		);
		pi.writeRunningGoal("Continue after restoring this session");

		await pi.restart();

		const continuation = await pi.waitForLlmRequest((request) => request.agentId === null, 10_000);
		const restoredChildRequest = await pi.waitForLlmRequest(
			(request) => request.agentId === child.id && request.id !== initialChildRequest.id,
			10_000,
		);
		expect(continuation.sessionId).toBe(pi.sessionId);
		expect(restoredChildRequest.userMessages).toContain("Wait across restart");
		expect(pi.listAgents().find((agent) => agent.id === child.id)?.lifecycle).toBe("running");
	});
}, 30_000);
