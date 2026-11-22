import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

const SOURCE_FILE = "consultation-source.txt";
const SOURCE_TEXT = "CONSULTATION_SOURCE_41b9: only the requesting child should receive this result.";
const WRITE_MARKER = "consultation-write-must-not-exist.txt";
const CONSULTATION_SUMMARY = "CONSULTATION_SUMMARY_41b9";
const REQUESTER_SUMMARY = "REQUESTER_SUMMARY_41b9";

function endTurn(reason: string) {
	return fauxAssistantMessage([{ type: "text", text: reason }, fauxToolCall("end_turn", { reason })], {
		stopReason: "toolUse",
	});
}

function toolResult(request: HeadlessLlmRequest, name: string) {
	const result = request.messages.find((message) => message.role === "toolResult" && message.toolName === name);
	if (!result || result.role !== "toolResult") throw new Error(`Missing ${name} result`);
	return result;
}

function resultText(request: HeadlessLlmRequest, name: string): string {
	const result = toolResult(request, name);
	expect(result.isError, `${name} result`).toBe(false);
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function configureProfiles(agentDir: string): void {
	const settingsPath = join(agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	writeFileSync(
		settingsPath,
		JSON.stringify({
			...settings,
			agents: {
				default: { model: "headless-faux/headless-faux-1", thinkingLevel: "off" },
				implement: { model: "headless-faux/headless-faux-1", thinkingLevel: "off" },
				verifier: { model: "headless-faux/headless-faux-1", thinkingLevel: "off" },
				"documentation-update": { model: "headless-faux/headless-faux-1", thinkingLevel: "off" },
				reviewer: { model: "headless-faux/headless-faux-1", thinkingLevel: "off" },
				browser: { model: "headless-faux/headless-faux-1", thinkingLevel: "off", tools: ["browser-cli"] },
				explore: {
					model: "headless-faux/headless-faux-1",
					thinkingLevel: "off",
					tools: ["read", "write", "bash", "pyrun_eval", "spawn_agent"],
				},
			},
		}),
	);
}

async function spawnRequester(
	agent: HeadlessPi,
	agentType = "implement",
): Promise<{ id: string; request: HeadlessLlmRequest }> {
	await agent.send({ type: "prompt", message: "Create a regular child for consultation coverage." });
	const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		initial.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", {
				agentType,
				context: "fresh",
				displayName: "consultation-requester",
				prompt: "Use an explore consultation to inspect the source file, then report the result.",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent((candidate) => candidate.displayName === "consultation-requester");
	const mainAfterSpawn = await agent.waitForLlmRequest(
		(request) => request.agentId === null && request.id !== initial.id,
	);
	return { id: child.id, request: mainAfterSpawn };
}

async function spawnAttachedRequester(agent: HeadlessPi): Promise<{ id: string; request: HeadlessLlmRequest }> {
	const savedSession = SessionManager.create(agent.paths.workspaceDir, agent.paths.sessionDir);
	savedSession.setMetadataControlDbPath(getControlDbPath(agent.paths.agentDir));
	savedSession.appendMessage({ role: "user", content: "Saved attached-session context", timestamp: 1 });
	savedSession.appendMessage(fauxAssistantMessage("Saved attached-session checkpoint"));
	const sessionFile = savedSession.getSessionFile();
	if (!sessionFile) throw new Error("Saved requester session has no transcript path");
	await agent.send({ type: "prompt", message: "Attach the saved requester session." });
	const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		initial.id,
		fauxAssistantMessage(
			fauxToolCall("attach_session_agent", {
				agentType: "implement",
				displayName: "attached-consultation-requester",
				path: sessionFile,
				prompt: "Use an explore consultation to inspect the source file, then report the result.",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent((candidate) => candidate.displayName === "attached-consultation-requester");
	const mainAfterAttach = await agent.waitForLlmRequest(
		(request) => request.agentId === null && request.id !== initial.id,
	);
	return { id: child.id, request: mainAfterAttach };
}

async function requestConsultation(
	agent: HeadlessPi,
	request: HeadlessLlmRequest,
	requesterId: string,
	parallelAttempt = false,
): Promise<HeadlessLlmRequest> {
	const calls = [
		fauxToolCall("spawn_agent", {
			agentType: "explore",
			context: "fresh",
			displayName: "source-consultation",
			prompt: `Read ${SOURCE_FILE} and return its exact marker.`,
		}),
	];
	if (parallelAttempt) {
		calls.push(
			fauxToolCall("spawn_agent", {
				agentType: "explore",
				context: "fresh",
				displayName: "duplicate-consultation",
				parentId: requesterId,
				prompt: "This parallel consultation must be rejected.",
			}),
		);
	}
	agent.respondToLlmRequest(request.id, fauxAssistantMessage(calls, { stopReason: "toolUse" }));
	const consultation = await agent.waitForAgent((candidate) => candidate.displayName === "source-consultation");
	expect(consultation.parentId).toBe(requesterId);
	expect(agent.listAgents().filter((candidate) => candidate.parentId === requesterId)).toHaveLength(1);
	const consultationRequest = await agent.waitForLlmRequest((candidate) => candidate.agentId === consultation.id);
	const activeConsultation = await agent.waitForAgent(
		(candidate) => candidate.id === consultation.id && candidate.currentActivity?.phase === "thinking",
	);
	expect(activeConsultation.currentActivity?.phase).toBe("thinking");
	const names = consultationRequest.tools?.map((tool) => tool.name) ?? [];
	expect(names).toContain("read");
	expect(names).not.toContain("write");
	expect(names).not.toContain("edit");
	expect(names).not.toContain("bash");
	expect(names).not.toContain("pyrun_eval");
	expect(names).not.toContain("spawn_agent");
	return consultationRequest;
}

describe("child explore consultations", () => {
	it("preserves a live consultation across supervisor restart and delivers its result only to the requester", async () => {
		await withHeadlessPi(async (agent) => {
			configureProfiles(agent.paths.agentDir);
			writeFileSync(join(agent.paths.workspaceDir, SOURCE_FILE), SOURCE_TEXT);
			await agent.restart();

			const { id: requesterId } = await spawnRequester(agent);
			const requesterRequest = await agent.waitForLlmRequest((request) => request.agentId === requesterId);
			const consultationRequest = await requestConsultation(agent, requesterRequest, requesterId);
			const consultation = agent.listAgents().find((candidate) => candidate.displayName === "source-consultation");
			if (!consultation) throw new Error("Consultation agent was not persisted");
			const requester = agent.listAgents().find((candidate) => candidate.id === requesterId);
			if (!requester?.transcript) throw new Error("Requester transcript was not persisted");

			agent.respondToLlmRequest(
				consultationRequest.id,
				fauxAssistantMessage(fauxToolCall("read", { path: SOURCE_FILE }), { stopReason: "toolUse" }),
			);
			const consultationAfterRead = await agent.waitForLlmRequest(
				(request) => request.agentId === consultation.id && request.id !== consultationRequest.id,
			);
			expect(resultText(consultationAfterRead, "read")).toContain(SOURCE_TEXT);
			expect(consultationAfterRead.tools?.map((tool) => tool.name)).not.toContain("spawn_agent");

			// Force disallowed calls through the faux provider. They must not run or create descendants.
			agent.respondToLlmRequest(
				consultationAfterRead.id,
				fauxAssistantMessage(
					[
						fauxToolCall("write", { path: WRITE_MARKER, content: "forbidden" }),
						fauxToolCall("edit", { path: WRITE_MARKER, oldText: "x", newText: "y" }),
						fauxToolCall("bash", { command: `touch ${WRITE_MARKER}` }),
						fauxToolCall("pyrun_eval", {
							code: `from pathlib import Path; Path(${JSON.stringify(WRITE_MARKER)}).write_text("forbidden")`,
						}),
						fauxToolCall("spawn_agent", {
							agentType: "explore",
							context: "fresh",
							displayName: "recursive-consultation",
							prompt: "Recursive delegation must be denied.",
						}),
					],
					{ stopReason: "toolUse" },
				),
			);
			const postForcedCalls = await agent.waitForLlmRequest(
				(request) => request.agentId === consultation.id && request.id !== consultationAfterRead.id,
			);
			for (const name of ["write", "edit", "bash", "pyrun_eval", "spawn_agent"]) {
				expect(toolResult(postForcedCalls, name).isError, `${name} forced call`).toBe(true);
			}
			expect(existsSync(join(agent.paths.workspaceDir, WRITE_MARKER))).toBe(false);
			expect(agent.listAgents().filter((candidate) => candidate.parentId === consultation.id)).toHaveLength(0);
			expect(agent.listAgents().filter((candidate) => candidate.parentId === requesterId)).toHaveLength(1);

			// Stop the supervisor while the consultation's next model request is still unresolved.
			expect(agent.listAgents().find((candidate) => candidate.id === requesterId)?.lifecycle).toBe("running");
			await agent.crash();
			await agent.restart();
			expect(agent.listAgents().find((candidate) => candidate.id === requesterId)?.transcript).toEqual(
				requester.transcript,
			);
			expect(agent.listAgents().find((candidate) => candidate.id === consultation.id)?.transcript).toEqual(
				consultation.transcript,
			);
			const restoredConsultationRequest = await agent.waitForLlmRequest(
				(request) => request.agentId === consultation.id,
			);
			expect(restoredConsultationRequest.userMessages.join("\n")).toContain("Read consultation-source.txt");
			expect(agent.listAgents().find((candidate) => candidate.id === requesterId)?.lifecycle).toBe("running");
			const recoveredRequesterRequest = await agent.waitForLlmRequest((request) => request.agentId === requesterId);
			expect(recoveredRequesterRequest.userMessages.join("\n")).toContain(
				"Continue the conversation from where it left off",
			);
			agent.respondToLlmRequest(
				recoveredRequesterRequest.id,
				endTurn("Recovered requester is waiting for its consultation."),
			);

			agent.respondToLlmRequest(restoredConsultationRequest.id, endTurn(CONSULTATION_SUMMARY));
			const requesterContinuation = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === requesterId && request.userMessages.join("\n").includes(CONSULTATION_SUMMARY),
			);
			expect(requesterContinuation.userMessages.join("\n").split(CONSULTATION_SUMMARY)).toHaveLength(2);
			expect(requesterContinuation.tools?.map((tool) => tool.name)).toContain("spawn_agent");
			expect(agent.listAgents().filter((candidate) => candidate.parentId === requesterId)).toHaveLength(1);
			expect(
				agent
					.readSessionEntries(null)
					.some(
						(entry) => entry.type === "message" && JSON.stringify(entry.message).includes(CONSULTATION_SUMMARY),
					),
			).toBe(false);
			expect(existsSync(join(agent.paths.workspaceDir, WRITE_MARKER))).toBe(false);

			agent.respondToLlmRequest(
				requesterContinuation.id,
				fauxAssistantMessage(
					[
						fauxToolCall("spawn_agent", {
							context: "fresh",
							displayName: "omitted-type-consultation",
							prompt: "An omitted type must be rejected.",
						}),
						fauxToolCall("spawn_agent", {
							agentType: "implement",
							context: "fresh",
							displayName: "wrong-type-consultation",
							prompt: "A non-explore type must be rejected.",
						}),
						fauxToolCall("spawn_agent", {
							agentType: "explore",
							context: "fresh",
							displayName: "wrong-parent-consultation",
							parentId: "not-the-requester",
							prompt: "This consultation must fail before creating a row.",
						}),
					],
					{ stopReason: "toolUse" },
				),
			);
			const requesterAfterInvalid = await agent.waitForLlmRequest(
				(request) => request.agentId === requesterId && request.id !== requesterContinuation.id,
			);
			const invalidCallResults = requesterAfterInvalid.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "spawn_agent",
			);
			expect(invalidCallResults).toHaveLength(3);
			expect(JSON.stringify(invalidCallResults)).toContain("Child agents can only spawn explore consultations.");
			expect(JSON.stringify(invalidCallResults)).toContain(
				"Explore consultations must belong to the requesting child.",
			);
			for (const name of ["omitted-type-consultation", "wrong-type-consultation", "wrong-parent-consultation"]) {
				expect(agent.listAgents().some((candidate) => candidate.displayName === name)).toBe(false);
			}

			agent.respondToLlmRequest(requesterAfterInvalid.id, endTurn(REQUESTER_SUMMARY));
			await agent.waitForAgent((candidate) => candidate.id === requesterId && candidate.lifecycle === "completed");
			await agent.waitForAgent(
				(candidate) => candidate.id === consultation.id && candidate.lifecycle === "completed",
			);
			expect(
				agent.readSessionEntries(requesterId).filter((entry) => entry.type === "message").length,
			).toBeGreaterThan(0);
			expect(agent.listAgents().filter((candidate) => candidate.parentId === requesterId)).toHaveLength(1);
			expect(
				agent
					.readSessionEntries(null)
					.some(
						(entry) => entry.type === "message" && JSON.stringify(entry.message).includes(CONSULTATION_SUMMARY),
					),
			).toBe(false);
			expect(
				agent
					.listAgents()
					.some((candidate) => candidate.agentType === "explore" && candidate.id !== consultation.id),
			).toBe(false);
		});
	}, 180_000);

	it.each([
		"default",
		"implement",
		"verifier",
		"documentation-update",
		"reviewer",
		"browser",
		"explore",
		"attached",
	] as const)("allows a %s child to consult once and keeps the result out of the main wait", async (kind) => {
		await withHeadlessPi(async (agent) => {
			configureProfiles(agent.paths.agentDir);
			writeFileSync(join(agent.paths.workspaceDir, SOURCE_FILE), SOURCE_TEXT);
			await agent.restart();
			const { id: requesterId, request: mainRequest } =
				kind === "attached" ? await spawnAttachedRequester(agent) : await spawnRequester(agent, kind);
			const requesterRequest = await agent.waitForLlmRequest((request) => request.agentId === requesterId);
			const consultationRequest = await requestConsultation(agent, requesterRequest, requesterId, true);
			const consultation = agent.listAgents().find((candidate) => candidate.displayName === "source-consultation");
			if (!consultation) throw new Error("Consultation agent was not persisted");
			agent.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
			);
			agent.respondToLlmRequest(
				consultationRequest.id,
				fauxAssistantMessage(fauxToolCall("read", { path: SOURCE_FILE }), { stopReason: "toolUse" }),
			);
			const afterRead = await agent.waitForLlmRequest(
				(request) => request.agentId === consultation.id && request.id !== consultationRequest.id,
			);
			expect(resultText(afterRead, "read")).toContain(SOURCE_TEXT);
			agent.respondToLlmRequest(afterRead.id, endTurn(CONSULTATION_SUMMARY));
			const requesterContinuation = await agent.waitForLlmRequest(
				(request) =>
					request.agentId === requesterId && request.userMessages.join("\n").includes(CONSULTATION_SUMMARY),
			);
			const spawnResults = requesterContinuation.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "spawn_agent",
			);
			expect(spawnResults).toHaveLength(2);
			expect(JSON.stringify(spawnResults)).toContain("already has an active explore consultation");
			expect(agent.listAgents().filter((candidate) => candidate.parentId === requesterId)).toHaveLength(1);
			agent.respondToLlmRequest(requesterContinuation.id, endTurn(REQUESTER_SUMMARY));
			const mainWaitResult = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			expect(toolResult(mainWaitResult, "wait_agent").isError).toBe(false);
			expect(JSON.stringify(toolResult(mainWaitResult, "wait_agent"))).not.toContain(CONSULTATION_SUMMARY);
			expect(
				agent
					.readSessionEntries(requesterId)
					.filter(
						(entry) => entry.type === "message" && JSON.stringify(entry.message).includes(CONSULTATION_SUMMARY),
					),
			).toHaveLength(1);
			agent.respondToLlmRequest(mainWaitResult.id, endTurn("Main wait completed without the consultation result."));
		});
	});
});
