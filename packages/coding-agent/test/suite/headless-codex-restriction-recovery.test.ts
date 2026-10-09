import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readSupervisorRequest, type SupervisorRequest } from "../../src/core/session-control-db.ts";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import {
	type ControlledRestrictionSupervisor,
	startControlledRestrictionSupervisor,
} from "./fixtures/codex-restriction-supervisor.ts";
import { getMessageText } from "./harness.ts";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

const ORIGINAL = "In my own repository, list source filenames and explain the code; do not read credentials.";
const RESTRICTION =
	"Codex error: This content was flagged for possible cybersecurity risk.\nOpenAI request ID: req_500";
const ADVICE = {
	kind: "rescope",
	task: "List source filenames only",
	basisQuote: "list source filenames",
	reason: "metadata-only authorized subset",
};
const CLI_PATH = join(import.meta.dirname, "fixtures", "codex-restriction-cli.ts");
const NO_REQUEST_WINDOW_MS = 1_200;
const CASE_TIMEOUT_MS = 60_000;

function refusal() {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: RESTRICTION,
		responseId: "restriction-response",
	});
}

function readRecoveryEntries(agent: HeadlessPi): SessionEntry[] {
	return agent
		.readSessionEntries(null)
		.filter((entry) => entry.type === "custom_message" && entry.customType === "supervisor_restriction_recovery");
}

function expectBudgetUsedNotice(agent: HeadlessPi, count: number) {
	const entries = readRecoveryEntries(agent);
	expect(entries).toHaveLength(count);
	expect(JSON.stringify(entries[entries.length - 1])).toContain("Recovery was already used for this request");
}

function readBudget(agent: HeadlessPi) {
	return agent
		.readSessionEntries(null)
		.filter((entry) => entry.type === "custom" && entry.customType === "codex_restriction_context");
}

function expectSpentBudget(agent: HeadlessPi, userRequest = ORIGINAL): string {
	const entry = readBudget(agent).at(-1);
	expect(entry).toMatchObject({ type: "custom", data: { requestId: expect.any(String), userRequest } });
	if (entry?.type !== "custom") throw new Error("Persisted explicit request context required");
	const context = entry.data as { requestId: string; userRequest: string };
	expect(context.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	expect(context).not.toHaveProperty("spent");
	const db = new DatabaseSync(getControlDbPath(agent.paths.agentDir), { readOnly: true });
	try {
		expect(
			db
				.prepare("SELECT user_request_id FROM codex_restriction_recovery_claims WHERE user_request_id = ?")
				.all(context.requestId),
		).toEqual([{ user_request_id: context.requestId }]);
	} finally {
		db.close();
	}
	return context.requestId;
}

function expectOriginalHistory(agent: HeadlessPi, count = 1): void {
	const messages = agent
		.readSessionEntries(null)
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
	expect(messages.some((message) => message.role === "user" && getMessageText(message) === ORIGINAL)).toBe(true);
	const refusals = messages.filter((message) => message.role === "assistant" && message.errorMessage === RESTRICTION);
	expect(refusals).toHaveLength(count);
	for (const message of refusals) {
		expect(message).toMatchObject({
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "headless-faux-codex",
			responseId: "restriction-response",
			stopReason: "error",
			errorMessage: RESTRICTION,
		});
	}
}

function readAccessFiles(agent: HeadlessPi): Record<string, string | null> {
	return Object.fromEntries(
		["models.json", "settings.json", "auth.json"].map((file) => {
			const path = join(agent.paths.agentDir, file);
			return [file, existsSync(path) ? readFileSync(path, "utf8") : null];
		}),
	);
}

async function expectNoModelRequest(agent: HeadlessPi): Promise<void> {
	await expect(agent.waitForLlmRequest(undefined, NO_REQUEST_WINDOW_MS)).rejects.toThrow(
		"Timed out waiting for LLM request",
	);
	expect((await agent.send({ type: "get_state" })).success).toBe(true);
}

async function withRecoveryPi(
	run: (agent: HeadlessPi, supervisor: ControlledRestrictionSupervisor) => Promise<void>,
): Promise<void> {
	await withHeadlessPi(
		async (agent) => {
			const supervisor = await startControlledRestrictionSupervisor(agent);
			try {
				await run(agent, supervisor);
			} finally {
				await supervisor.close();
			}
		},
		{ provider: "openai-codex", cliPath: CLI_PATH },
	);
}

async function startRefusal(agent: HeadlessPi, message = ORIGINAL): Promise<HeadlessLlmRequest> {
	expect((await agent.send({ type: "prompt", message })).success).toBe(true);
	const initial = await agent.waitForLlmRequest();
	agent.respondToLlmRequest(initial.id, refusal());
	await agent.waitForEvent(
		(event) =>
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.errorMessage === RESTRICTION,
	);
	return initial;
}

async function claimRestriction(supervisor: ControlledRestrictionSupervisor): Promise<SupervisorRequest> {
	const request = await supervisor.claim();
	expect(request.kind).toBe("supervisor_advisory");
	const evidence = JSON.parse(String(request.payload.context));
	expect(evidence).toMatchObject({
		originalUserRequest: ORIGINAL,
		failure: {
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "headless-faux-codex",
			errorMessage: RESTRICTION,
			responseId: "restriction-response",
		},
	});
	expect(request.payload.question).toContain("genuinely different, narrower, permitted subtask");
	return request;
}

async function answerRescope(supervisor: ControlledRestrictionSupervisor, request: SupervisorRequest): Promise<void> {
	expect(await supervisor.answer(request, { kind: "advisory", answer: JSON.stringify(ADVICE) })).toMatchObject({
		status: "completed",
	});
}

function readProviderRequests(agent: HeadlessPi) {
	return readFileSync(join(agent.paths.agentDir, "restriction-provider-requests.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					api: string;
					provider: string;
					model: string;
					tools: string[];
					reasoning?: string;
					transport?: string;
				},
		);
}

async function answerValidation(agent: HeadlessPi, proposal = ADVICE, allowed = true): Promise<HeadlessLlmRequest> {
	const validation = await agent.waitForLlmRequest(undefined, 5_000);
	expect(validation.agentId).toBeNull();
	expect(validation.tools ?? []).toEqual([]);
	expect(validation.userMessages).toContain(ORIGINAL);
	expect(readProviderRequests(agent).at(-1)?.reasoning).toBe(readProviderRequests(agent)[0]?.reasoning);
	expect(readProviderRequests(agent).at(-1)?.transport).toBe(readProviderRequests(agent)[0]?.transport);
	expect(JSON.stringify(validation.messages)).toContain(proposal.task);
	expect(JSON.stringify(validation.messages)).toContain(RESTRICTION.replace(/\n/g, "\\n"));
	expect(readProviderRequests(agent).at(-1)).toMatchObject({
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "headless-faux-codex",
		tools: [],
	});
	agent.respondToLlmRequest(
		validation.id,
		fauxAssistantMessage(
			JSON.stringify({
				allowed,
				task: proposal.task,
				reason: allowed
					? "Distinct filename-only work is explicitly authorized."
					: "The user prohibits reading credentials.",
				basisQuote: allowed ? "list source filenames" : "do not read credentials",
			}),
		),
	);
	return validation;
}

async function finishSubset(agent: HeadlessPi): Promise<HeadlessLlmRequest> {
	await answerValidation(agent);
	const permitted = await agent.waitForLlmRequest();
	expect(JSON.stringify(permitted.messages)).toContain(ADVICE.task);
	expect(permitted.tools?.length).toBeGreaterThan(0);
	agent.respondToLlmRequest(
		permitted.id,
		fauxAssistantMessage(
			[
				{ type: "text", text: "src/one.ts\nsrc/two.ts" },
				fauxToolCall("end_turn", { reason: "Permitted filenames listed; original request remains pending" }),
			],
			{ stopReason: "toolUse" },
		),
	);
	await agent.waitForEvent(
		(event) =>
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			getMessageText(event.message) === "src/one.ts\nsrc/two.ts",
	);
	return permitted;
}

describe("real-process Codex restriction recovery", () => {
	it.each([undefined, "Inspect the explicitly authorized repository without reading credentials"])(
		"takes one permitted subset without replaying a completed tool or changing request, goal, model, effort or access (goal: %s)",
		async (objective) => {
			await withRecoveryPi(async (agent, supervisor) => {
				if (objective) agent.writeRunningGoal(objective);
				const model = agent.readSessionMetadata(null);
				const access = readAccessFiles(agent);
				const effectPath = join(agent.paths.workspaceDir, "effect-count.txt");
				await agent.send({ type: "prompt", message: ORIGINAL });
				const initial = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(
					initial.id,
					fauxAssistantMessage(
						fauxToolCall("restriction_completed_effect", { path: effectPath }, { id: "completed-effect" }),
						{ stopReason: "toolUse" },
					),
				);
				const afterTool = await agent.waitForLlmRequest();
				expect(readFileSync(effectPath, "utf8")).toBe("completed\n");
				// Normal user-input evidence is now recorded; recovery must preserve this goal.
				const goal = agent.readGoal();
				expect(goal?.objective).toBe(objective);
				agent.respondToLlmRequest(afterTool.id, refusal());
				await agent.waitForEvent(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.errorMessage === RESTRICTION,
				);
				const advisory = await claimRestriction(supervisor);
				const evidence = JSON.parse(String(advisory.payload.context));
				if (goal) expect(JSON.parse(evidence.activeGoal)).toEqual(goal);
				else expect(evidence.activeGoal).toBeUndefined();
				await answerRescope(supervisor, advisory);
				const validation = await answerValidation(agent);
				expect(validation.messages).toContainEqual(
					expect.objectContaining({ role: "toolResult", toolCallId: "completed-effect" }),
				);
				expect(readFileSync(effectPath, "utf8")).toBe("completed\n");
				const permitted = await agent.waitForLlmRequest(undefined, 5_000).catch((error: unknown) => {
					const entries = agent.readSessionEntries(null).slice(-6);
					throw new Error(`${String(error)}\nDurable refusal/advice boundary: ${JSON.stringify(entries)}`);
				});
				expect(permitted.userMessages).toContain(ORIGINAL);
				expect(permitted.messages).toContainEqual(
					expect.objectContaining({ role: "toolResult", toolCallId: "completed-effect" }),
				);
				// The original refusal is durable; the provider-facing context includes its verbatim text in the advice.
				expect(JSON.stringify(permitted.messages)).toContain(RESTRICTION.replace(/\n/g, "\\n"));
				expect(JSON.stringify(permitted.messages)).toContain(ADVICE.task);
				expect(permitted.tools).toEqual(initial.tools);
				expectOriginalHistory(agent);
				expect(agent.readGoal()).toEqual(goal);
				expect(agent.readSessionMetadata(null)).toEqual(model);
				expect(readAccessFiles(agent)).toEqual(access);
				// A second flag must stop; any replay would append a second observable effect.
				agent.respondToLlmRequest(permitted.id, refusal());
				await agent.waitForEvent(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.errorMessage === RESTRICTION,
				);
				await expectNoModelRequest(agent);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expectBudgetUsedNotice(agent, 2);
				expect(readProviderRequests(agent)).toHaveLength(4);
				expectOriginalHistory(agent, 2);
				expectSpentBudget(agent);
				expect(readFileSync(effectPath, "utf8")).toBe("completed\n");
				expect(agent.readGoal()).toEqual(goal);
				expect(agent.readSessionMetadata(null)).toEqual(model);
				expect(readAccessFiles(agent)).toEqual(access);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"returns a permitted filename answer once with no terminal automatic resubmission",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				await answerRescope(supervisor, await claimRestriction(supervisor));
				await finishSubset(agent);
				await expectNoModelRequest(agent);
				expect(readProviderRequests(agent)).toHaveLength(3);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expect(readRecoveryEntries(agent)).toHaveLength(1);
				expectOriginalHistory(agent);
				expectSpentBudget(agent);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"leaves the original error terminal when Supervisor establishes no permitted subset",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				const advisory = await claimRestriction(supervisor);
				await supervisor.answer(advisory, {
					kind: "advisory",
					answer: JSON.stringify({ kind: "blocked", reason: "No permitted subset within existing authorization" }),
				});
				await agent.waitForSessionEntry(
					null,
					(entry) => entry.type === "custom_message" && entry.customType === "supervisor_restriction_recovery",
				);
				await expectNoModelRequest(agent);
				expect(JSON.stringify(readRecoveryEntries(agent))).toContain("No automatic task execution");
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expectOriginalHistory(agent);
				expectSpentBudget(agent);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"cancels while the resident child is live and rejects late advice without replanning",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				const advisory = await claimRestriction(supervisor);
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
				expect((await agent.send({ type: "abort" })).success).toBe(true);
				await expect(
					supervisor.answer(advisory, { kind: "advisory", answer: JSON.stringify(ADVICE) }),
				).rejects.toThrow("claim lost");
				expect(readSupervisorRequest(getControlDbPath(agent.paths.agentDir), advisory.id)).toMatchObject({
					status: "cancelled",
				});
				await expectNoModelRequest(agent);
				expect(readRecoveryEntries(agent)).toHaveLength(0);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expectOriginalHistory(agent);
				expectSpentBudget(agent);
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"discards advice after semantic session context changes while the resident child is live",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				const advisory = await claimRestriction(supervisor);
				await agent.send({ type: "prompt", message: "/restriction-branch" });
				await agent.waitForSessionEntry(
					null,
					(entry) => entry.type === "custom_message" && entry.customType === "restriction-test-branch",
				);
				await answerRescope(supervisor, advisory);
				await expectNoModelRequest(agent);
				expect(readRecoveryEntries(agent)).toHaveLength(0);
				expectOriginalHistory(agent);
				expectSpentBudget(agent);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"discards stale advice rather than undoing an explicit model change while Supervisor is live",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				const advisory = await claimRestriction(supervisor);
				expect(
					(await agent.send({ type: "set_model", provider: "headless-faux", modelId: "headless-faux-1" })).success,
				).toBe(true);
				const selected = agent.readSessionMetadata(null);
				expect(selected).toMatchObject({ modelProvider: "headless-faux", modelId: "headless-faux-1" });
				await answerRescope(supervisor, advisory);
				await expectNoModelRequest(agent);
				expect(agent.readSessionMetadata(null)).toEqual(selected);
				expect(readRecoveryEntries(agent)).toHaveLength(0);
				expectOriginalHistory(agent);
				expectSpentBudget(agent);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"survives an abrupt Pi restart while Supervisor is live, without late replan, duplicate advice or renewed extension budget",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				const advisory = await claimRestriction(supervisor);
				const sessionId = agent.sessionId;
				const sessionFile = agent.sessionFile;
				const model = agent.readSessionMetadata(null);
				const consumedRequestId = expectSpentBudget(agent);
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
				await agent.crash();
				// Complete the real durable request after its caller died, before replacement Pi starts.
				await answerRescope(supervisor, advisory);
				await agent.restart();
				expect(await agent.send({ type: "get_state" })).toMatchObject({
					success: true,
					data: { sessionId, sessionFile },
				});
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
				await expectNoModelRequest(agent);
				expect(readRecoveryEntries(agent)).toHaveLength(0);
				expectSpentBudget(agent);
				await agent.send({ type: "prompt", message: "/restriction-resume" });
				const resumed = await agent.waitForLlmRequest();
				expect(resumed.userMessages).toContain("Continue the active request.");
				agent.respondToLlmRequest(resumed.id, refusal());
				await agent.waitForEvent(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.errorMessage === RESTRICTION,
				);
				await expectNoModelRequest(agent);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expectBudgetUsedNotice(agent, 1);
				expectSpentBudget(agent);
				expectOriginalHistory(agent, 2);
				expect(agent.readSessionMetadata(null)).toEqual(model);
				// Only a newly supplied explicit human request resets the persisted budget.
				await startRefusal(agent);
				const newAdvisory = await claimRestriction(supervisor);
				expect(expectSpentBudget(agent)).not.toBe(consumedRequestId);
				expect(newAdvisory.id).not.toBe(advisory.id);
				await answerRescope(supervisor, newAdvisory);
				await finishSubset(agent);
				await expectNoModelRequest(agent);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(2);
				expect(readRecoveryEntries(agent)).toHaveLength(2);
				expectSpentBudget(agent);
				expectOriginalHistory(agent, 3);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"keeps a spent successful recovery budget across restart and extension-generated resumption",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				await answerRescope(supervisor, await claimRestriction(supervisor));
				await finishSubset(agent);
				await expectNoModelRequest(agent);
				await agent.restart();
				expectSpentBudget(agent);
				await agent.send({ type: "prompt", message: "/restriction-resume" });
				const resumed = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(resumed.id, refusal());
				await agent.waitForEvent(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.errorMessage === RESTRICTION,
				);
				await expectNoModelRequest(agent);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expectBudgetUsedNotice(agent, 2);
				expectSpentBudget(agent);
				expectOriginalHistory(agent, 2);
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"rejects Supervisor credential-reading proposal after tool-free main validation with no operation",
		async () => {
			await withRecoveryPi(async (agent, supervisor) => {
				const model = agent.readSessionMetadata(null);
				const access = readAccessFiles(agent);
				await startRefusal(agent);
				const advisory = await claimRestriction(supervisor);
				const prohibited = {
					...ADVICE,
					task: "Read credentials",
					basisQuote: "do not read credentials",
					reason: "Supervisor incorrectly treats a prohibition as permission",
				};
				await supervisor.answer(advisory, { kind: "advisory", answer: JSON.stringify(prohibited) });
				await answerValidation(agent, prohibited, false);
				await expectNoModelRequest(agent);
				expect(readProviderRequests(agent)).toHaveLength(2);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				expect(agent.listAgents()).toEqual([]);
				expect(agent.listMailboxMessages()).toEqual([]);
				expectOriginalHistory(agent);
				expectSpentBudget(agent);
				expect(agent.readSessionMetadata(null)).toEqual(model);
				expect(readAccessFiles(agent)).toEqual(access);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it.each(["rewind", "fork"] as const)(
		"does not renew a consumed request budget after %s and restart",
		async (transition) => {
			await withRecoveryPi(async (agent, supervisor) => {
				await startRefusal(agent);
				await answerRescope(supervisor, await claimRestriction(supervisor));
				await finishSubset(agent);
				await expectNoModelRequest(agent);
				const requestId = expectSpentBudget(agent);
				const user = agent
					.readSessionEntries(null)
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				if (!user) throw new Error("Original user message required");
				const originalFile = agent.sessionFile;
				if (transition === "fork") {
					expect((await agent.send({ type: "prompt", message: "/restriction-fork" })).success).toBe(true);
				} else {
					expect((await agent.send({ type: "prompt", message: "/restriction-rewind" })).success).toBe(true);
				}
				const state = await agent.send({ type: "get_state" });
				if (!state.success || state.command !== "get_state" || !state.data.sessionFile)
					throw new Error("Transition session identity required");
				const transitionedFile = state.data.sessionFile;
				const inheritedContext = SessionManager.open(transitionedFile)
					.getBranch()
					.find((entry) => entry.type === "custom" && entry.customType === "codex_restriction_context");
				expect(inheritedContext).toMatchObject({ data: { requestId, userRequest: ORIGINAL } });
				if (transition === "fork") expect(transitionedFile).not.toBe(originalFile);
				await agent.restart();
				if (transition === "fork") {
					expect(await agent.send({ type: "switch_session", sessionPath: transitionedFile })).toMatchObject({
						success: true,
						data: { cancelled: false },
					});
				}
				await agent.send({ type: "prompt", message: "/restriction-resume" });
				const resumed = await agent.waitForLlmRequest();
				expect(resumed.userMessages).toContain("Continue the active request.");
				agent.respondToLlmRequest(resumed.id, refusal());
				await agent.waitForEvent(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						event.message.errorMessage === RESTRICTION,
				);
				await expectNoModelRequest(agent);
				expect(readProviderRequests(agent)).toHaveLength(4);
				expect(agent.countSupervisorRequests("supervisor_advisory")).toBe(1);
				const notices = SessionManager.open(transitionedFile)
					.getBranch()
					.filter(
						(entry) => entry.type === "custom_message" && entry.customType === "supervisor_restriction_recovery",
					);
				expect(JSON.stringify(notices[notices.length - 1])).toContain("Recovery was already used for this request");
				expect(await supervisor.ping()).toEqual({ pid: supervisor.pid, ready: true });
				// The global helper intentionally reads its original file; return there for durable claim proof.
				if (transition === "fork") await agent.send({ type: "switch_session", sessionPath: originalFile });
				expect(expectSpentBudget(agent)).toBe(requestId);
			});
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"skips all Supervisor contact and automatic attempts in NoSupervisor mode",
		async () => {
			await withHeadlessPi(
				async (agent) => {
					await startRefusal(agent);
					await expectNoModelRequest(agent);
					expect(agent.readSupervisorActivity()).toEqual({
						connections: 0,
						starts: 0,
						requests: 0,
						listeners: 0,
						cursors: 0,
						agents: 0,
					});
					expect(await agent.send({ type: "get_messages" })).toMatchObject({
						success: true,
						data: {
							messages: expect.arrayContaining([
								expect.objectContaining({
									role: "assistant",
									api: "openai-codex-responses",
									errorMessage: RESTRICTION,
								}),
							]),
						},
					});
				},
				{ noSupervisor: true, provider: "openai-codex", cliPath: CLI_PATH },
			);
		},
		CASE_TIMEOUT_MS,
	);
});
