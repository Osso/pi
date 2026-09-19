import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

function complete(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

async function selectChild(agent: HeadlessPi, request: HeadlessLlmRequest, agentId: string): Promise<void> {
	agent.respondToLlmRequest(
		request.id,
		fauxAssistantMessage(
			fauxToolCall("pyrun_eval", { code: `print(pi.agents.select(${JSON.stringify(agentId)}))` }),
			{ stopReason: "toolUse" },
		),
	);
	const next = await agent.waitForLlmRequest((candidate) => candidate.agentId === null && candidate.id !== request.id);
	const selection = next.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "pyrun_eval",
	);
	expect(selection).toMatchObject({ isError: false });
	agent.respondToLlmRequest(next.id, complete("Child selected"));
	await agent.waitForEvent((event) => event.type === "agent_end");
}

describe("production child session mutation", () => {
	it.each([false, true])("routes slash commands to the live child (supervisor restarted: %s)", async (restart) => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Spawn a child for live effort changes" });
			const first = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				first.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Mutable child",
						prompt: "Remain live while the supervisor changes effort",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const child = await agent.waitForAgent((candidate) => candidate.displayName === "Mutable child");
			let childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			let mainRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== first.id,
			);
			if (restart) {
				await agent.crash();
				await agent.restart();
				childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
				mainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.transcript).toEqual(
					child.transcript,
				);
				expect(childRequest.userMessages).toContain("Remain live while the supervisor changes effort");
			}
			await selectChild(agent, mainRequest, child.id);
			const mainBefore = agent.readSessionMetadata(null);
			expect(
				await agent.send({ type: "prompt", message: "/model headless-faux/headless-faux-reasoning" }),
			).toMatchObject({ success: true });
			expect(await agent.send({ type: "prompt", message: "/effort high" })).toMatchObject({ success: true });
			expect(agent.readSessionMetadata(child.id)).toMatchObject({
				modelProvider: "headless-faux",
				modelId: "headless-faux-reasoning",
				thinkingLevel: "high",
			});
			expect(agent.readSessionMetadata(null)).toEqual(mainBefore);
			agent.respondToLlmRequest(childRequest.id, complete("Child continued after effort change"));
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		});
	});
});
