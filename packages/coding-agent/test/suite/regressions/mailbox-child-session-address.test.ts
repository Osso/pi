import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { getMessageText } from "../harness.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

function endTurn(reason: string) {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" });
}

it.each(["main", "supervisor"])(
	"rejects an attached child's session addressed as %s without breaking offline main queueing",
	async (mainTarget) => {
		await withHeadlessPi(async (agent) => {
			const saved = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
			saved.setMetadataControlDbPath(getControlDbPath(agent.paths.agentDir));
			saved.appendMessage({ role: "user", content: "Saved work before attachment", timestamp: 1 });
			saved.appendMessage(fauxAssistantMessage("Saved checkpoint"));
			const savedSessionId = saved.getSessionId();
			const offlineBody = "Queue for the offline main thread only";
			await agent.send({ type: "prompt", message: "Queue an offline message, then attach its session" });
			const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initial.id,
				fauxAssistantMessage(
					fauxToolCall("send_agent_message", {
						toAgentId: mainTarget,
						toSessionId: savedSessionId,
						body: offlineBody,
					}),
					{ stopReason: "toolUse" },
				),
			);
			const afterOfflineSend = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(afterOfflineSend.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
				toolName: "send_agent_message",
				isError: false,
			});
			expect(agent.listRuntimeMailboxMessages()).toMatchObject([
				{ body: offlineBody, recipient: { sessionId: savedSessionId, agentId: null }, status: "pending" },
			]);
			const assignment = "Wait for a correctly addressed approval";
			agent.respondToLlmRequest(
				afterOfflineSend.id,
				fauxAssistantMessage(
					fauxToolCall("attach_session_agent", {
						path: saved.getSessionFile(),
						displayName: "Address regression worker",
						prompt: assignment,
					}),
					{ stopReason: "toolUse" },
				),
			);
			const child = await agent.waitForAgent(
				(candidate) => candidate.displayName === "Address regression worker" && candidate.lifecycle === "running",
			);
			expect(requireHeadlessAgentSessionId(child)).toBe(savedSessionId);
			const childRequest = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			expect(childRequest.userMessages).toContain(assignment);
			const afterAttach = await agent.waitForLlmRequest((request) => request.agentId === null);
			const rejectedBody = "Approval addressed to the wrong main inbox";
			agent.respondToLlmRequest(
				afterAttach.id,
				fauxAssistantMessage(
					fauxToolCall(
						"send_agent_message",
						{ toAgentId: mainTarget, toSessionId: savedSessionId, body: rejectedBody },
						{ id: "wrong-child-main" },
					),
					{ stopReason: "toolUse" },
				),
			);
			const afterRejectedSend = await agent.waitForLlmRequest((request) => request.agentId === null);
			const rejected = afterRejectedSend.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "wrong-child-main",
			);
			expect(rejected, getMessageText(rejected)).toMatchObject({ isError: true });
			expect(getMessageText(rejected)).toContain(savedSessionId);
			expect(getMessageText(rejected)).toContain(child.id);
			expect(agent.listRuntimeMailboxMessages().map((message) => message.body)).toEqual([offlineBody]);
			const approvalBody = "Explicit approval delivered through the child agent ID";
			agent.respondToLlmRequest(
				afterRejectedSend.id,
				fauxAssistantMessage(fauxToolCall("send_agent_message", { toAgentId: child.id, body: approvalBody }), {
					stopReason: "toolUse",
				}),
			);
			const afterCorrectSend = await agent.waitForLlmRequest((request) => request.agentId === null);
			expect(afterCorrectSend.messages.filter((message) => message.role === "toolResult").at(-1)).toMatchObject({
				toolName: "send_agent_message",
				isError: false,
			});
			agent.respondToLlmRequest(afterCorrectSend.id, endTurn("Approval sent"));
			await agent.waitForEvent((event) => event.type === "agent_end");
			// Reach the child's post-tool checkpoint while its original provider request was already active.
			agent.respondToLlmRequest(
				childRequest.id,
				fauxAssistantMessage(fauxToolCall("read", { path: saved.getSessionFile() }), { stopReason: "toolUse" }),
			);
			const accepted = await agent.waitForLlmRequest((request) => request.agentId === child.id);
			expect(accepted.userMessages.filter((text) => text.includes(approvalBody))).toHaveLength(1);
			expect(accepted.userMessages.some((text) => text.includes(rejectedBody))).toBe(false);
			expect(accepted.userMessages.some((text) => text.includes(offlineBody))).toBe(false);
			expect(agent.listRuntimeMailboxMessages().map((message) => message.body)).toEqual([offlineBody]);
			agent.respondToLlmRequest(accepted.id, endTurn("Worker received approval"));
			await agent.waitForAgent((candidate) => candidate.id === child.id && candidate.lifecycle === "completed");
			const completed = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.userMessages.some((text) => text.includes("Address regression worker completed")),
			);
			agent.respondToLlmRequest(completed.id, endTurn("Worker completion received"));
			await agent.waitForEvent((event) => event.type === "agent_end");
		});
	},
	60_000,
);
