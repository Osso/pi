import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

const CONTINUE_GOAL = "Continue working toward the active goal.";
const MISSION = "Keep the faux platform healthy";

it("starts each goal continuation with exactly one prompt, including from the agent_end review", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: `/mission set ${MISSION}` });
		const missionStart = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		expect(missionStart.userMessages).toEqual([CONTINUE_GOAL]);

		// Each manage_goal action re-copies the mission during the run; none may queue a follow-up.
		pi.respondToLlmRequest(
			missionStart.id,
			fauxAssistantMessage(
				[
					fauxToolCall("manage_goal", { action: "pause", reason: "Need the user to decide." }),
					fauxToolCall("manage_goal", { action: "clear" }),
					fauxToolCall("manage_goal", { action: "pause", reason: "Blocked on review." }),
				],
				{ stopReason: "toolUse" },
			),
		);
		const afterTools = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		expect(afterTools.userMessages).toEqual([CONTINUE_GOAL]);
		pi.respondToLlmRequest(
			afterTools.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Mission work recorded" }), { stopReason: "toolUse" }),
		);

		// The run's own review continues it; a Supervisor complete on a mission goal continues inside agent_end.
		const review = await pi.waitForSupervisorRequest("goal_idle_review");
		expect(review.payload).toMatchObject({ objective: MISSION });
		pi.respondToSupervisorRequest(review, { kind: "complete", reason: "Mission looks done" });

		const continued = await pi.waitForLlmRequest((request) => request.sessionId === pi.sessionId);
		expect(continued.userMessages).toEqual([CONTINUE_GOAL, CONTINUE_GOAL]);
		expect(pi.countSupervisorRequests("goal_idle_review")).toBe(1);
		expect(pi.readGoal()).toMatchObject({ objective: MISSION, mission: true, continuationTurns: 1 });
		expect(pi.readGoal()).not.toHaveProperty("pausedAt");
	});
});
