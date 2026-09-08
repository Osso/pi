import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { getMessageText } from "./harness.ts";
import { withHeadlessPi } from "./headless-pi.ts";

const LOOP_PROMPT = "Inspect the active recovery once.";
const REAL_PROCESS_TEST_TIMEOUT_MS = 60_000;

function fauxEndTurn(reason: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" });
}

function entryText(entry: SessionEntry): string {
	return entry.type === "message" ? getMessageText(entry.message) : "";
}

describe("loop extension runtime", () => {
	it(
		"survives a loop start from an active model during session shutdown",
		async () => {
			await withHeadlessPi(
				async (agent) => {
					await agent.send({ type: "prompt", message: "Start work before session replacement" });
					const request = await agent.waitForLlmRequest();
					const replacement = agent.send({ type: "new_session" });
					const enteredPath = join(agent.paths.workspaceDir, "shutdown-entered");
					try {
						await expect.poll(() => existsSync(enteredPath), { timeout: 5_000 }).toBe(true);
						expect(readFileSync(enteredPath, "utf8")).toBe(agent.sessionId);
						agent.respondToLlmRequest(
							request.id,
							fauxAssistantMessage(
								fauxToolCall("loop", { action: "start", intervalSeconds: 1, prompt: LOOP_PROMPT }),
								{ stopReason: "toolUse" },
							),
						);
						await agent.waitForSessionEntry(
							null,
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolName === "loop" &&
								entry.message.isError === true &&
								entryText(entry).includes("Cannot start a loop after session shutdown"),
						);
					} finally {
						writeFileSync(join(agent.paths.workspaceDir, "shutdown-release"), "release");
						await replacement;
					}
					await delay(1_200);
					await agent.send({ type: "prompt", message: "Confirm replacement remains usable" });
					const resumed = await agent.waitForLlmRequest((candidate) =>
						candidate.userMessages.includes("Confirm replacement remains usable"),
					);
					agent.respondToLlmRequest(
						resumed.id,
						fauxAssistantMessage(
							fauxToolCall("loop", { action: "start", intervalSeconds: 1, prompt: "Fresh session loop" }),
							{ stopReason: "toolUse" },
						),
					);
					const freshWork = await agent.waitForLlmRequest(
						(candidate) =>
							candidate.id !== request.id &&
							candidate.id !== resumed.id &&
							candidate.userMessages.includes("Confirm replacement remains usable"),
					);
					agent.respondToLlmRequest(freshWork.id, fauxEndTurn("Replacement remains usable"));
					const freshLoop = await agent.waitForLlmRequest((candidate) =>
						candidate.userMessages.includes("Fresh session loop"),
					);
					expect(freshLoop.userMessages).not.toContain(LOOP_PROMPT);
					agent.respondToLlmRequest(
						freshLoop.id,
						fauxAssistantMessage(fauxToolCall("loop", { action: "stop" }), { stopReason: "toolUse" }),
					);
					const stopped = await agent.waitForLlmRequest(
						(candidate) => candidate.id !== freshLoop.id && candidate.userMessages.includes("Fresh session loop"),
					);
					agent.respondToLlmRequest(stopped.id, fauxEndTurn("Fresh loop stopped"));
					await agent.waitForEvent((event) => event.type === "agent_end");
				},
				{ cliPath: join(import.meta.dirname, "fixtures", "loop-shutdown-race-cli.ts") },
			);
		},
		REAL_PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"coalesces interval ticks while a real turn is busy",
		async () => {
			await withHeadlessPi(async (agent) => {
				await agent.send({ type: "prompt", message: "Start recurring recovery checks" });
				const initialRequest = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(
					initialRequest.id,
					fauxAssistantMessage(
						fauxToolCall("loop", { action: "start", intervalSeconds: 1, prompt: LOOP_PROMPT }),
						{
							stopReason: "toolUse",
						},
					),
				);

				const busyRequest = await agent.waitForLlmRequest((request) => request.id !== initialRequest.id);
				await delay(2_200);
				agent.respondToLlmRequest(busyRequest.id, fauxEndTurn("Initial work complete"));

				const loopRequest = await agent.waitForLlmRequest(
					(request) => request.id !== initialRequest.id && request.id !== busyRequest.id,
				);
				expect(loopRequest.userMessages.filter((message) => message === LOOP_PROMPT)).toHaveLength(1);

				const loopEntries = agent
					.readSessionEntries(null)
					.filter((entry) => entry.type === "custom_message" && entry.customType === "loop");
				expect(loopEntries).toHaveLength(1);
				expect(loopEntries[0]).toMatchObject({ content: LOOP_PROMPT, display: true });
				await delay(2_200);

				agent.respondToLlmRequest(
					loopRequest.id,
					fauxAssistantMessage(fauxToolCall("loop", { action: "stop" }), { stopReason: "toolUse" }),
				);
				const stoppedRequest = await agent.waitForLlmRequest(
					(request) =>
						request.id !== initialRequest.id && request.id !== busyRequest.id && request.id !== loopRequest.id,
				);
				agent.respondToLlmRequest(stoppedRequest.id, fauxEndTurn("Loop test settled"));
				await agent.waitForSessionEntry(
					null,
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "end_turn" &&
						entryText(entry).includes("Loop test settled"),
				);
				await delay(1_200);

				const finalEntries = agent.readSessionEntries(null);
				expect(
					finalEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "loop"),
				).toHaveLength(1);
				expect(
					finalEntries.filter(
						(entry) =>
							entry.type === "message" && entry.message.role === "user" && entryText(entry) === LOOP_PROMPT,
					),
				).toHaveLength(0);
			});
		},
		REAL_PROCESS_TEST_TIMEOUT_MS,
	);
});
