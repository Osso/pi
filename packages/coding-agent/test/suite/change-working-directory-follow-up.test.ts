import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

function endTurn(reason: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text: "Done." }, fauxToolCall("end_turn", { reason })], {
		stopReason: "toolUse",
	});
}

async function waitForIdle(agent: HeadlessPi): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const state = await agent.send({ type: "get_state" });
		if (
			state.success &&
			"data" in state &&
			(state.data as { isStreaming?: boolean } | undefined)?.isStreaming === false
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for relocated session to become idle");
}

it("delivers a queued follow-up exactly once after cwd relocation", async () => {
	await withHeadlessPi(
		async (agent) => {
			const targetCwd = join(agent.paths.tempDir, "next-project");
			mkdirSync(targetCwd);
			const initialPrompt = "Move to the next project";
			const followUp = "Review the follow-up marker 7421";
			await agent.send({ type: "prompt", message: initialPrompt });
			const initialRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.userMessages.includes(initialPrompt),
			);

			const acceptedFollowUp = await agent.send({ type: "follow_up", message: followUp });
			expect(acceptedFollowUp.success).toBe(true);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(
					fauxToolCall("change_working_directory", { path: targetCwd }, { id: "relocate-with-queued-follow-up" }),
				),
			);
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "cwd_changed" &&
					typeof entry.content === "string" &&
					entry.content.includes(targetCwd),
			);

			const continuedRequest = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null && request.id !== initialRequest.id && !request.userMessages.includes(followUp),
			);
			agent.respondToLlmRequest(continuedRequest.id, endTurn("Relocated turn complete"));
			const followUpRequest = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.id !== continuedRequest.id &&
					request.userMessages.includes(followUp),
			);
			expect(followUpRequest.userMessages.filter((message) => message === followUp)).toHaveLength(1);

			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(followUp),
			);
			agent.respondToLlmRequest(followUpRequest.id, endTurn("Follow-up complete"));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("Follow-up complete"),
			);
			await waitForIdle(agent);

			const followUpEntries = agent
				.readSessionEntries(null)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes(followUp),
				);
			expect(followUpEntries).toHaveLength(1);
		},
		{ noSessionName: true },
	);
}, 60_000);
