import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readUserQuestion } from "../../src/core/session-control-db.ts";
import { askUserQuestion } from "../../src/user-questions/ask.ts";
import { withHeadlessPi } from "./headless-pi.ts";

it("delivers user questions, records model answers, and carries answers into follow-ups", async () => {
	await withHeadlessPi(async (agent) => {
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const firstId = askUserQuestion(controlDbPath, { sessionId: agent.sessionId }, "Which database?");
		const firstRequest = await agent.waitForLlmRequest();
		expect(firstRequest.userMessages.join("\n")).toContain(`User question ${firstId}: Which database?`);
		expect(firstRequest.tools?.some((tool) => tool.name === "answer_user_question")).toBe(true);
		agent.respondToLlmRequest(
			firstRequest.id,
			fauxAssistantMessage(fauxToolCall("answer_user_question", { id: firstId, answer: "SQLite" }), {
				stopReason: "toolUse",
			}),
		);
		await expect.poll(() => readUserQuestion(controlDbPath, firstId)?.answer).toBe("SQLite");
		const afterAnswerRequest = await agent.waitForLlmRequest();
		agent.respondToLlmRequest(afterAnswerRequest.id, fauxAssistantMessage("Answer recorded."));
		const followUpId = askUserQuestion(controlDbPath, { sessionId: "ignored-session" }, "Why?", firstId);
		await agent.send({ type: "prompt", message: "Continue." });
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
	});
}, 60_000);
