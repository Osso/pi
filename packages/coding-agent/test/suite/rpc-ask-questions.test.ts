import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { RpcExtensionUIRequest } from "../../src/modes/rpc/rpc-types.ts";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

const QUESTION = "Which test runner should this project use?";
const NAME_QUESTION = "What should the binary be called?";

type QuestionsRequest = Extract<RpcExtensionUIRequest, { method: "questions" }>;

async function askBlocking(agent: HeadlessPi): Promise<QuestionsRequest> {
	await agent.send({ type: "prompt", message: "Pick a runner." });
	agent.respondToLlmRequest(
		(await agent.waitForLlmRequest()).id,
		fauxAssistantMessage(
			[
				fauxToolCall("ask_questions", {
					blocking: true,
					questions: [
						{
							question: QUESTION,
							header: "Runner",
							options: [{ label: "vitest", description: "Fast" }, { label: "jest" }],
						},
						{ question: NAME_QUESTION },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
	);
	const request = await agent.waitForExtensionUiRequest((candidate) => candidate.method === "questions");
	return request as QuestionsRequest;
}

async function finishTurn(agent: HeadlessPi): Promise<string> {
	const followUp = await agent.waitForLlmRequest((request) => JSON.stringify(request.messages).includes("answered"));
	agent.respondToLlmRequest(
		followUp.id,
		fauxAssistantMessage([{ type: "text", text: "Done." }, fauxToolCall("end_turn", { reason: "Done." })], {
			stopReason: "toolUse",
		}),
	);
	await agent.waitForEvent((event) => event.type === "agent_end");
	const result = followUp.messages.find((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("No ask_questions result reached the model");
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("ask_questions over RPC", () => {
	it("sends the questions to the client and returns its answers to the model", async () => {
		await withHeadlessPi(
			async (agent) => {
				const request = await askBlocking(agent);
				expect(request.questions).toEqual([
					{
						question: QUESTION,
						header: "Runner",
						options: [{ label: "vitest", description: "Fast" }, { label: "jest" }],
					},
					{ question: NAME_QUESTION },
				]);

				await agent.respondToExtensionUiRequest({
					type: "extension_ui_response",
					id: request.id,
					answers: { [QUESTION]: "vitest", [NAME_QUESTION]: "pi-desktop" },
				});

				expect(await finishTurn(agent)).toBe(
					`User answered questions:\n- ${QUESTION} → vitest\n- ${NAME_QUESTION} → pi-desktop`,
				);
			},
			{ noSupervisor: true },
		);
	}, 60_000);

	it("dismisses the client's questions when the Supervisor answers first", async () => {
		await withHeadlessPi(async (agent) => {
			const request = await askBlocking(agent);
			const posted = await agent.waitForSupervisorRequest("question");
			agent.respondToSupervisorRequest(posted, {
				kind: "answer",
				answers: {
					[QUESTION]: { answer: "vitest", reason: "AGENTS.md names vitest" },
					[NAME_QUESTION]: { answer: "pi-desktop", reason: "Cargo.toml package name" },
				},
			});

			const dismissal = await agent.waitForEvent(
				(event) => (event as { type: string }).type === "extension_ui_dismiss",
			);
			expect(dismissal).toEqual({ type: "extension_ui_dismiss", id: request.id });
			expect(await finishTurn(agent)).toContain(`${QUESTION} → vitest (Supervisor: AGENTS.md names vitest)`);
		});
	}, 60_000);
});
