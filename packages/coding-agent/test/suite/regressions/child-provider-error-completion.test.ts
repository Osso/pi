import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getMessageText } from "../harness.ts";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const PARENT_SUMMARY = "Parent-only historical result: all probes prepared";
const ASSIGNMENT = "Read the current probe implementation, not the parent summary";
const PROVIDER_ERROR =
	"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code";

function completedMessage(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

async function spawnInheritedChild(agent: HeadlessPi) {
	await agent.send({ type: "set_session_name", name: "Child provider failure regression" });
	await agent.send({ type: "prompt", message: "Record the previous parent result" });
	const seedRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(seedRequest.id, completedMessage(PARENT_SUMMARY));
	await agent.waitForEvent((event) => event.type === "agent_end");

	await agent.send({ type: "prompt", message: "Delegate a new investigation" });
	const spawnRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		spawnRequest.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", {
				context: "inherit",
				displayName: "Provider failure regression",
				prompt: ASSIGNMENT,
			}),
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent((candidate) => candidate.displayName === "Provider failure regression");
	const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === child.id);
	expect(request.userMessages).toContain(ASSIGNMENT);
	expect(request.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
		PARENT_SUMMARY,
	);
	return { child, request };
}

async function finishParentTurn(agent: HeadlessPi) {
	const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
	agent.respondToLlmRequest(request.id, completedMessage("Parent awaiting child outcome"));
}

describe("child provider failure completion", () => {
	it.each([
		{ restart: false, partialText: "" },
		{ restart: true, partialText: "" },
		{ restart: false, partialText: "Unfinished child output" },
	])("preserves provider errors instead of inherited success: %j", async ({ restart, partialText }) => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			let currentRequest = request;
			if (restart) {
				await agent.crash();
				await agent.restart();
				currentRequest = await agent.waitForLlmRequest(
					(candidate) => candidate.sessionId === child.transcript?.sessionId,
				);
				expect(currentRequest.userMessages).toContain(ASSIGNMENT);
				expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.transcript).toEqual(
					child.transcript,
				);
			}
			await finishParentTurn(agent);
			agent.respondToLlmRequest(
				currentRequest.id,
				fauxAssistantMessage(partialText ? [{ type: "text", text: partialText }] : [], {
					stopReason: "error",
					errorMessage: PROVIDER_ERROR,
				}),
			);
			const terminal = await agent.waitForAgent(
				(candidate) => candidate.id === child.id && ["failed", "completed"].includes(candidate.lifecycle),
			);
			expect(terminal.lifecycle).toBe("failed");
			expect(terminal.error?.message).toBe(PROVIDER_ERROR);
			expect(terminal.result).toBeUndefined();
			const notification = await agent.waitForMailboxMessage(
				(message) => message.fromAgentId === child.id && message.toAgentId === "main",
			);
			expect(notification.body).toContain(PROVIDER_ERROR);
			expect(notification.body).not.toContain(PARENT_SUMMARY);
			expect(agent.listMailboxMessages().filter((message) => message.fromAgentId === child.id)).toHaveLength(1);
		});
	});

	it("keeps the child's own summary before a tool-only end_turn", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			await finishParentTurn(agent);
			agent.respondToLlmRequest(request.id, fauxAssistantMessage("Current child result"));
			const endTurnRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === child.id);
			agent.respondToLlmRequest(
				endTurnRequest.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" }),
			);
			const terminal = await agent.waitForAgent(
				(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
			);
			expect(terminal.result?.summary).toBe("Current child result");
		});
	});

	it("does not borrow a parent summary when the child ends without text", async () => {
		await withHeadlessPi(async (agent) => {
			const { child, request } = await spawnInheritedChild(agent);
			await finishParentTurn(agent);
			agent.respondToLlmRequest(
				request.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "No textual result" }), { stopReason: "toolUse" }),
			);
			const terminal = await agent.waitForAgent(
				(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
			);
			expect(terminal.result).toBeUndefined();
		});
	});
});
