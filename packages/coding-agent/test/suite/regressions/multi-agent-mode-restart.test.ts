import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

it("restores disabled delegation across restart without cancelling live child work", async () => {
	await withHeadlessPi(
		async (agent) => {
			await agent.send({ type: "prompt", message: "Start child work before disabling delegation" });
			const initialRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			expect(initialRequest.systemPrompt).toContain("Proactive multi-agent delegation is active.");
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Disabled-mode live child",
						prompt: "Remain live across supervisor restart",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const child = await agent.waitForAgent(
				(candidate) => candidate.displayName === "Disabled-mode live child" && candidate.lifecycle === "running",
			);
			const childSessionId = requireHeadlessAgentSessionId(child);
			await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
			const afterSpawn = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				afterSpawn.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Child remains live" }), { stopReason: "toolUse" }),
			);
			await agent.waitForEvent((event) => event.type === "agent_end");
			const sessionId = agent.sessionId;

			await agent.send({ type: "prompt", message: "/effort high" });
			await agent.send({ type: "prompt", message: "/multi-agent disabled" });
			expect(agent.readSessionEntries(null)).toContainEqual(
				expect.objectContaining({ type: "custom", customType: "multi-agent-mode", data: { mode: "disabled" } }),
			);
			await agent.restart();

			expect(agent.sessionId).toBe(sessionId);
			expect(await agent.send({ type: "get_state" })).toMatchObject({
				command: "get_state",
				success: true,
				data: { model: { id: "headless-faux-reasoning" }, thinkingLevel: "high", sessionId },
			});
			const restoredChildRequest = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
			expect(agent.listAgents().find((candidate) => candidate.id === child.id)).toMatchObject({
				lifecycle: "running",
				transcript: { sessionId: childSessionId, path: child.transcript?.path },
			});

			await agent.send({ type: "prompt", message: "Continue with restored disabled settings" });
			const disabledRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			expect(disabledRequest.systemPrompt).not.toContain("<multi_agent_mode>");
			expect(disabledRequest.systemPrompt).not.toContain("you must use spawn_agent");
			expect(disabledRequest.systemPrompt).not.toContain("- spawn_agent:");
			for (const name of [
				"spawn_agent",
				"attach_session_agent",
				"list_agents",
				"wait_agent",
				"close_agent",
				"steer_agent",
				"agent_viewer",
				"send_agent_message",
				"contact_parent",
			]) {
				expect(disabledRequest.tools?.map((tool) => tool.name)).not.toContain(name);
			}
			expect(disabledRequest.tools?.map((tool) => tool.name)).toContain("read");
			agent.respondToLlmRequest(
				disabledRequest.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Disabled settings confirmed" }), {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_end");

			agent.respondToLlmRequest(
				restoredChildRequest.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Child work completed" }), {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");

			const completionRequest = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.userMessages.some((message) => message.includes("Disabled-mode live child completed.")),
			);
			agent.respondToLlmRequest(
				completionRequest.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Child completion received" }), {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_end");

			const namingRequest = await agent.waitForLlmRequest(
				(request) => request.systemPrompt?.startsWith("Create a concise session title.") === true,
			);
			agent.respondToLlmRequest(namingRequest.id, fauxAssistantMessage("Delegation mode restart"));

			await agent.send({ type: "prompt", message: "/multi-agent proactive" });
			const status = await agent.waitForExtensionUiRequest(
				(request) =>
					request.method === "setStatus" &&
					request.statusKey === "multi-agent-mode" &&
					request.statusText?.includes("active") === true,
			);
			expect(status).toMatchObject({ statusKey: "multi-agent-mode" });
			await agent.send({ type: "prompt", message: "Confirm delegation is active again" });
			const enabledRequest = await agent.waitForLlmRequest(
				(candidate) =>
					candidate.agentId === null &&
					candidate.userMessages.some((message) => message.includes("Confirm delegation is active again")),
			);
			expect(enabledRequest.systemPrompt).toContain("Proactive multi-agent delegation is active.");
			expect(enabledRequest.systemPrompt).toContain("you must use spawn_agent");
			expect(enabledRequest.tools?.map((tool) => tool.name)).toContain("spawn_agent");
			agent.respondToLlmRequest(
				enabledRequest.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Active settings confirmed" }), {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_end");
		},
		{ model: "headless-faux-reasoning" },
	);
}, 30_000);
