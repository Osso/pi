import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../../src/core/multi-agent-store.ts";
import { withHeadlessPi } from "./headless-pi.ts";
import { spawnFreshAgentFromMain } from "./headless-spawn.ts";

function completed(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

describe("agents over RPC", () => {
	it("lists, steers and reads a child agent, and reports its updates", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Spawn a helper" });
			const mainRequest = await spawnFreshAgentFromMain(agent, "helper", "Greet the user");
			const update = (await agent.waitForEvent(
				(event) =>
					(event as { type: string }).type === "agent_updated" &&
					(event as unknown as { agent: AgentSnapshot }).agent.displayName === "helper",
			)) as unknown as { agent: AgentSnapshot };
			const childId = update.agent.id;
			const childRequest = await agent.waitForLlmRequest((request) => request.agentId === childId);
			const mainAfterSpawn = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			agent.respondToLlmRequest(mainAfterSpawn.id, completed("Spawned."));

			const listed = await agent.send({ type: "get_agents" });
			expect(listed).toMatchObject({ success: true, command: "get_agents" });
			const agents = (listed as { data: { agents: AgentSnapshot[] } }).data.agents;
			expect(agents.map((a) => [a.id, a.displayName])).toContainEqual([childId, "helper"]);

			const steered = await agent.send({ type: "steer_agent", agentId: childId, message: "Also say goodbye" });
			expect(steered).toMatchObject({ success: true, command: "steer_agent" });
			agent.respondToLlmRequest(childRequest.id, completed("Hello from the helper"));
			const steeredRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === childId && JSON.stringify(request.messages).includes("Also say goodbye"),
			);
			agent.respondToLlmRequest(steeredRequest.id, completed("Goodbye from the helper"));
			await agent.waitForAgent((candidate) => candidate.id === childId && candidate.lifecycle === "completed");

			const read = await agent.send({ type: "get_agent_messages", agentId: childId });
			expect(read).toMatchObject({ success: true, command: "get_agent_messages" });
			const transcript = JSON.stringify((read as { data: { messages: unknown[] } }).data.messages);
			expect(transcript).toContain("Greet the user");
			expect(transcript).toContain("Hello from the helper");
			expect(transcript).toContain("Goodbye from the helper");

			const unknown = await agent.send({ type: "get_agent_messages", agentId: "agent_missing" });
			expect(unknown).toMatchObject({ success: false, error: "Unknown agent: agent_missing" });
		});
	}, 90_000);
});
