import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	getControlDbPath,
	listRuntimeMailboxMessages,
	postSupervisorRequest,
	readSupervisorRequest,
	type SupervisorRequestStatus,
} from "../../src/core/session-control-db.ts";
import { answerQuestionAsUser, reviseQuestionAsUser } from "../../src/supervisor/question-answers.ts";
import { notifySupervisorRequest } from "../../src/supervisor/request-wake.ts";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

const QUESTION = "Which test runner should this project use?";

function makeSupervisorSession(agent: HeadlessPi): void {
	const settingsPath = join(agent.paths.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	writeFileSync(settingsPath, JSON.stringify({ ...settings, supervisor: { sessionId: agent.sessionId } }));
}

async function waitForStatus(controlDbPath: string, id: number, status: SupervisorRequestStatus): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (readSupervisorRequest(controlDbPath, id)?.status !== status) {
		if (Date.now() > deadline) {
			throw new Error(`Request ${id} is ${readSupervisorRequest(controlDbPath, id)?.status}, not ${status}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function mailIds(controlDbPath: string): string[] {
	return listRuntimeMailboxMessages(controlDbPath).map((message) => message.storeRef.messageId);
}

describe("headless Supervisor question store", () => {
	it("keeps an escalated question open across a Supervisor process restart, then answers and revises it", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Start the Supervisor session" });
			agent.respondToLlmRequest((await agent.waitForLlmRequest()).id, fauxAssistantMessage("Ready."));
			await agent.waitForSessionEntry(
				null,
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			makeSupervisorSession(agent);
			await agent.restart();
			const controlDbPath = getControlDbPath(agent.paths.agentDir);
			const supervisorSessionId = agent.sessionId;

			const id = postSupervisorRequest(controlDbPath, {
				deadlineAt: "9999-12-31T23:59:59.999Z",
				kind: "question",
				payload: { blocking: true, questions: [{ question: QUESTION }] },
				projectId: "pi",
				replyTo: { sessionId: "asker", agentId: null, requestId: "call-1" },
				senderSessionId: "asker",
			});
			notifySupervisorRequest(controlDbPath);
			const decision = await agent.waitForLlmRequest((request) =>
				JSON.stringify(request.messages).includes(QUESTION),
			);
			agent.respondToLlmRequest(
				decision.id,
				fauxAssistantMessage([fauxToolCall("supervisor_response", { kind: "escalate", reason: "Tradeoff." })], {
					stopReason: "toolUse",
				}),
			);
			await waitForStatus(controlDbPath, id, "escalated");
			expect(mailIds(controlDbPath)).toContain("supervisor_response:asker:main:call-1:escalate");

			await agent.restart();
			// The restarted process recovers its queue; an escalation is neither failed nor decided again.
			await agent.send({ type: "prompt", message: "Still there?" });
			agent.respondToLlmRequest((await agent.waitForLlmRequest()).id, fauxAssistantMessage("Yes."));
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("Yes."),
			);
			expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
				status: "escalated",
				response: { kind: "escalate", reason: "Tradeoff." },
			});

			expect(answerQuestionAsUser(controlDbPath, supervisorSessionId, id, { [QUESTION]: "vitest" })).toBeDefined();
			expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
				status: "completed",
				response: { answeredBy: "user", answers: { [QUESTION]: { answer: "vitest" } } },
			});
			expect(mailIds(controlDbPath)).toContain("supervisor_response:asker:main:call-1:answer");

			expect(reviseQuestionAsUser(controlDbPath, supervisorSessionId, id, { [QUESTION]: "jest" })).toBeDefined();
			const correction = listRuntimeMailboxMessages(controlDbPath).find((message) =>
				message.storeRef.messageId.startsWith("supervisor_correction:asker:main:call-1:"),
			);
			expect(correction?.body).toBe(`User revised answers (request call-1):\n- ${QUESTION} → jest`);
		});
	}, 90_000);
});
