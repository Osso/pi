import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

function toolText(messages: Message[], name: string): string {
	const result = messages.find((message) => message.role === "toolResult" && message.toolName === name);
	if (!result || result.role !== "toolResult") throw new Error(`Missing ${name} result`);
	expect(result.isError).toBe(false);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function endTurn(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

function waitForMainRequest(agent: HeadlessPi) {
	return agent.waitForLlmRequest((request) => request.agentId === null);
}

it("keeps a renamed live child and its identity across supervisor restart", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Spawn a child and rename it while it remains active." });
		const initial = await waitForMainRequest(agent);
		expect(initial.tools?.map((tool) => tool.name)).toContain("rename_agent");
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { context: "fresh", displayName: "Original task", prompt: "Wait for work." }),
				{ stopReason: "toolUse" },
			),
		);
		const child = await agent.waitForAgent((candidate) => candidate.displayName === "Original task");
		const childInitial = await agent.waitForLlmRequest((request) => request.agentId === child.id);
		expect(childInitial.tools?.map((tool) => tool.name)).not.toContain("rename_agent");
		const afterSpawn = await waitForMainRequest(agent);
		agent.respondToLlmRequest(
			afterSpawn.id,
			fauxAssistantMessage(fauxToolCall("rename_agent", { agentId: child.id, displayName: "  Renamed task  " }), {
				stopReason: "toolUse",
			}),
		);
		const afterRename = await waitForMainRequest(agent);
		expect(toolText(afterRename.messages, "rename_agent")).toContain('"Renamed task"');
		const renamed = await agent.waitForAgent(
			(candidate) => candidate.id === child.id && candidate.displayName === "Renamed task",
		);
		expect(renamed).toMatchObject({ lifecycle: "running", transcript: child.transcript, model: child.model });
		agent.respondToLlmRequest(
			afterRename.id,
			fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
		);
		const afterList = await waitForMainRequest(agent);
		expect(toolText(afterList.messages, "list_agents")).toContain(`id=${child.id} name="Renamed task"`);
		agent.respondToLlmRequest(afterList.id, endTurn("Renamed child remains live."));
		await agent.waitForEvent((event) => event.type === "agent_end");

		const sessionId = agent.sessionId;
		const sessionFile = agent.sessionFile;
		await agent.restart();
		expect(agent.sessionId).toBe(sessionId);
		expect(agent.sessionFile).toBe(sessionFile);
		const resumed = await agent.waitForLlmRequest((request) => request.agentId === child.id);
		expect(resumed.tools?.map((tool) => tool.name)).not.toContain("rename_agent");
		const restored = await agent.waitForAgent(
			(candidate) => candidate.id === child.id && candidate.lifecycle === "running",
		);
		expect(restored).toMatchObject({ displayName: "Renamed task", transcript: child.transcript, model: child.model });
		expect(agent.listAgents().filter((candidate) => candidate.id === child.id)).toHaveLength(1);
		agent.respondToLlmRequest(resumed.id, endTurn("Child work completed."));
		const completed = await agent.waitForAgent(
			(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
		);
		expect(completed.displayName).toBe("Renamed task");
		const completion = await waitForMainRequest(agent);
		expect(completion.userMessages.join("\n")).toContain("Renamed task completed:");
		agent.respondToLlmRequest(completion.id, endTurn("Renamed child completion received."));
		await agent.waitForEvent((event) => event.type === "agent_end");
	});
}, 120_000);
