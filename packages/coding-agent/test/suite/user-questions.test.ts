import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readUserQuestion } from "../../src/core/session-control-db.ts";
import { askUserQuestion } from "../../src/user-questions/ask.ts";
import { withHeadlessPi } from "./headless-pi.ts";

function finishTurn(text: string) {
	return fauxAssistantMessage([text, fauxToolCall("end_turn", { reason: text })], { stopReason: "toolUse" });
}

it("delivers user questions, records model answers, and carries answers into follow-ups", async () => {
	await withHeadlessPi(async (agent) => {
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		await agent.send({ type: "prompt", message: "Initialize the main session" });
		const initialRequest = await agent.waitForLlmRequest();
		const initialEnded = agent.waitForEvent((event) => event.type === "agent_end");
		agent.respondToLlmRequest(initialRequest.id, finishTurn("Ready."));
		await initialEnded;
		await agent.waitForSessionEntry(null, (entry) => entry.type === "message" && entry.message.role === "assistant");

		const firstId = askUserQuestion(controlDbPath, { sessionId: agent.sessionId }, "Which database?");
		const firstRequest = await agent.waitForLlmRequest((request) =>
			request.userMessages.some((message) => message.includes(`User question ${firstId}`)),
		);
		expect(firstRequest.userMessages.join("\n")).toContain(`User question ${firstId}: Which database?`);
		expect(firstRequest.tools?.some((tool) => tool.name === "answer_user_question")).toBe(true);
		agent.respondToLlmRequest(
			firstRequest.id,
			fauxAssistantMessage(fauxToolCall("answer_user_question", { id: firstId, answer: "SQLite" }), {
				stopReason: "toolUse",
			}),
		);
		await expect.poll(() => readUserQuestion(controlDbPath, firstId)?.answer).toBe("SQLite");
		const afterAnswerRequest = await agent.waitForLlmRequest((request) =>
			request.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "answer_user_question",
			),
		);
		const answerTurnEnded = agent.waitForEvent((event) => event.type === "agent_end");
		agent.respondToLlmRequest(afterAnswerRequest.id, finishTurn("Answer recorded."));
		await answerTurnEnded;
		await agent.waitForSessionEntry(null, (entry) => entry.type === "message" && entry.message.role === "assistant");

		const followUpId = askUserQuestion(controlDbPath, { sessionId: "ignored-session" }, "Why?", firstId);
		const followUpRequest = await agent.waitForLlmRequest((request) =>
			request.userMessages.some((message) => message.includes(`User follow-up question ${followUpId}`)),
		);
		expect(followUpRequest.userMessages.join("\n")).toContain(
			`User follow-up question ${followUpId} (to question ${firstId}: "Which database?" → "SQLite"): Why?`,
		);
		agent.respondToLlmRequest(
			followUpRequest.id,
			fauxAssistantMessage(fauxToolCall("answer_user_question", { id: followUpId, answer: "It is embedded." }), {
				stopReason: "toolUse",
			}),
		);
		await expect.poll(() => readUserQuestion(controlDbPath, followUpId)?.answer).toBe("It is embedded.");
		const followUpAnswerRequest = await agent.waitForLlmRequest((request) =>
			request.messages.some(
				(message) => message.role === "toolResult" && message.toolName === "answer_user_question",
			),
		);
		const followUpEnded = agent.waitForEvent((event) => event.type === "agent_end");
		agent.respondToLlmRequest(followUpAnswerRequest.id, finishTurn("Follow-up recorded."));
		await followUpEnded;
	});
}, 60_000);
