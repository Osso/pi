import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

it("restores explicit delegation mode and effort after supervisor restart", async () => {
	await withHeadlessPi(
		async (agent) => {
			await agent.send({ type: "prompt", message: "Persist the session before changing delegation mode" });
			const initialRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			agent.respondToLlmRequest(initialRequest.id, fauxAssistantMessage("Session persisted"));
			await agent.waitForSessionEntry(
				null,
				(entry) => entry.type === "message" && JSON.stringify(entry.message).includes("Session persisted"),
			);
			const sessionId = agent.sessionId;

			await agent.send({ type: "prompt", message: "/effort high" });
			await agent.send({ type: "prompt", message: "/multi-agent explicit" });

			await agent.restart();

			expect(agent.sessionId).toBe(sessionId);
			const state = await agent.send({ type: "get_state" });
			expect(state).toMatchObject({
				command: "get_state",
				success: true,
				data: {
					model: { id: "headless-faux-reasoning" },
					thinkingLevel: "high",
					sessionId,
				},
			});

			await agent.send({ type: "prompt", message: "Continue with the restored session settings" });
			const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			expect(request.systemPrompt).toContain(
				"Any earlier instruction enabling proactive multi-agent delegation no longer applies.",
			);
			expect(request.systemPrompt).toContain(
				"Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents",
			);
			expect(request.systemPrompt).not.toContain("Proactive multi-agent delegation is active.");
			agent.respondToLlmRequest(request.id, fauxAssistantMessage("Restored settings confirmed"));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" && JSON.stringify(entry.message).includes("Restored settings confirmed"),
			);
		},
		{ model: "headless-faux-reasoning" },
	);
}, 30_000);
