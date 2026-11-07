import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

function endTurn(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

describe("attach_session_agent model", () => {
	it("resumes the attached session on its own stored model, not the parent's", async () => {
		await withHeadlessPi(async (agent) => {
			const saved = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
			saved.setMetadataControlDbPath(getControlDbPath(agent.paths.agentDir));
			saved.appendMessage({ role: "user", content: "Earlier assignment", timestamp: 1 });
			saved.appendMessage(fauxAssistantMessage("Earlier progress"));
			saved.setSessionModel("headless-faux", "headless-faux-reasoning");
			saved.setSessionThinkingLevel("high");
			const assignment = "Continue the interrupted assignment";

			await agent.send({ type: "prompt", message: "Resume the saved session" });
			const parent = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(parent.modelId).toBe("headless-faux-1");
			agent.respondToLlmRequest(
				parent.id,
				fauxAssistantMessage(
					fauxToolCall("attach_session_agent", {
						path: saved.getSessionFile(),
						displayName: "resumed",
						prompt: assignment,
					}),
					{ stopReason: "toolUse" },
				),
			);
			const child = await agent.waitForAgent(
				(candidate) => candidate.displayName === "resumed" && candidate.lifecycle === "running",
			);
			expect(requireHeadlessAgentSessionId(child)).toBe(saved.getSessionId());
			expect(child.model).toEqual({
				providerId: "headless-faux",
				modelId: "headless-faux-reasoning",
				thinkingLevel: "high",
			});

			const childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			expect(childRequest.userMessages).toContain(assignment);
			expect(childRequest.modelId).toBe("headless-faux-reasoning");

			const parentWait = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(parentWait.id, endTurn("Parent waiting"));
			agent.respondToLlmRequest(childRequest.id, endTurn("Child resumed on its stored model"));
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
		});
	}, 60_000);
});
