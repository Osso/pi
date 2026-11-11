import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

const MISSION = "Continuously maintain the test platform; failing services first, security second.";
const WORKING_GOAL = "Update only the image library pins";

async function finishMainTurn(pi: HeadlessPi, requestId: string, reason: string): Promise<void> {
	pi.respondToLlmRequest(
		requestId,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" }),
	);
	const review = await pi.waitForSupervisorRequest("goal_idle_review");
	pi.respondToSupervisorRequest(review, { kind: "wait", reason: "Waiting for the live child" });
	await pi.waitForSessionEntry(
		null,
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "supervisor-status" &&
			JSON.stringify(entry.data).includes("Waiting for the live child"),
	);
}

it("restores the compacted mission without replacing a working goal while a child survives process restart", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Initialize the persisted session before restart" });
		const initial = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		pi.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Session initialized" }), { stopReason: "toolUse" }),
		);
		await pi.waitForEvent((event) => event.type === "agent_end");
		const settingsPath = join(pi.paths.agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		writeFileSync(
			settingsPath,
			JSON.stringify({
				...settings,
				compaction: { enabled: true, keepRecentMessages: 3, reserveTokens: 16_384 },
			}),
		);
		await pi.send({ type: "prompt", message: `/mission set ${MISSION}` });
		await pi.waitForLlmRequest((request) => request.agentId === null);
		await pi.restart();
		const missionRequest = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		pi.respondToLlmRequest(
			missionRequest.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Mission restart child",
					prompt: "Keep the assigned investigation active through restart",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await pi.waitForAgent((agent) => agent.displayName === "Mission restart child");
		const childSessionId = requireHeadlessAgentSessionId(child);
		await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
		const afterSpawn = await pi.waitForLlmRequest((request) => request.agentId === null);
		await finishMainTurn(pi, afterSpawn.id, "Initial mission turn recorded");

		await pi.send({ type: "prompt", message: "/goal pause" });
		await pi.send({ type: "prompt", message: "Record a later turn before compaction" });
		const laterTurn = await pi.waitForLlmRequest((request) => request.agentId === null);
		pi.respondToLlmRequest(
			laterTurn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Later mission turn recorded" }), {
				stopReason: "toolUse",
			}),
		);
		await pi.waitForEvent((event) => event.type === "agent_end");
		const compaction = pi.send({ type: "compact" });
		const summaryRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
		pi.respondToLlmRequest(summaryRequest.id, fauxAssistantMessage("The child investigation remains active."));
		expect(await compaction).toMatchObject({ command: "compact", success: true });
		pi.writeRunningGoal(WORKING_GOAL);
		const savedWorkingGoal = pi.readGoal();

		await pi.restart();

		const restored = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		const restoredChild = await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
		expect(restored.sessionId).toBe(pi.sessionId);
		expect(restoredChild.userMessages).toContain("Keep the assigned investigation active through restart");
		expect(pi.listAgents().find((agent) => agent.id === child.id)).toMatchObject({
			lifecycle: "running",
			transcript: child.transcript,
		});
		expect(pi.readGoal()).toEqual(savedWorkingGoal);
		await pi.waitForExtensionUiRequest(
			(request) =>
				request.method === "setStatus" &&
				request.statusKey === "mission" &&
				request.statusText === `mission: ${MISSION}`,
		);
		await pi.send({ type: "prompt", message: "/mission" });
		await pi.waitForExtensionUiRequest(
			(request) => request.method === "notify" && request.message === `Mission: ${MISSION}`,
		);

		await pi.send({ type: "prompt", message: "/goal clear" });
		pi.respondToLlmRequest(
			restored.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Working goal cleared by user" }), {
				stopReason: "toolUse",
			}),
		);
		const missionResumed = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		expect(pi.readGoal()).toMatchObject({ objective: MISSION, mission: true });
		expect(missionResumed.systemPrompt).toContain(MISSION);
		expect(missionResumed.systemPrompt).toContain("It is never complete; only the user stops it.");
	});
}, 60_000);
