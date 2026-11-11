import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

const MISSION = "Continuously maintain the test platform; failing services first, security second.";
const WORKING_GOAL = "Update only the image library pins";
const RETAINED_PROMPT = "Record a later turn before compaction";

it("restores the compacted mission without replacing a working goal while a child survives process restart", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: `/mission set ${MISSION}` });
		const missionReview = await pi.waitForSupervisorRequest("goal_idle_review");
		expect(missionReview.payload).toMatchObject({ objective: MISSION });
		pi.respondToSupervisorRequest(missionReview, {
			kind: "continue",
			reason: "The mission has not started",
			instructions: "Start the mission.",
		});
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
		const afterSpawn = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		await pi.send({ type: "prompt", message: "/goal pause" });
		pi.respondToLlmRequest(
			afterSpawn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Initial mission turn recorded" }), {
				stopReason: "toolUse",
			}),
		);
		await pi.waitForEvent((event) => event.type === "agent_end");

		await pi.send({ type: "prompt", message: RETAINED_PROMPT });
		const laterTurn = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		pi.respondToLlmRequest(
			laterTurn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Later mission turn recorded" }), {
				stopReason: "toolUse",
			}),
		);
		await pi.waitForEvent((event) => event.type === "agent_end");
		await pi.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				JSON.stringify(entry.message).includes("Later mission turn recorded"),
		);

		// Persist the completed compaction checkpoint while the process is stopped, without model summarization.
		await pi.crash();
		const persisted = SessionManager.open(pi.sessionFile);
		const firstKept = persisted
			.getBranch()
			.reverse()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(RETAINED_PROMPT),
			);
		if (!firstKept) throw new Error("Missing retained turn before compaction");
		persisted.appendCompaction("The child investigation remains active.", firstKept.id, 30_000);
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
		expect(pi.readGoal()).toMatchObject({ objective: MISSION, mission: true });
	});
}, 60_000);
