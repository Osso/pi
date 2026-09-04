import { describe, expect, it } from "vitest";
import { createGoalReviewEvidenceController } from "../extensions/goal/src/goal-review-evidence.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

// No active goal exists yet: the first user request must still reach review.
function captureReviews() {
	const requests: Array<Record<string, unknown>> = [];
	const controller = createGoalReviewEvidenceController(
		{ loadActiveGoal: () => null, saveGoal: () => {} },
		async ({ payload }) => {
			requests.push(payload);
			return { kind: "set", objective: "Prove a clean workflow", reason: "User scope" };
		},
	);
	const ctx = { sessionManager: { getSessionId: () => "user-session" } } as ExtensionContext;
	return { controller, requests, ctx };
}

describe("Supervisor raw user evidence", () => {
	it("retains the first user request and does not replace it with extension input", async () => {
		const { controller, requests, ctx } = captureReviews();
		controller.appendInput(
			{ type: "input", text: "Discard the pilot tasks; prove a clean workflow", source: "interactive" },
			ctx,
		);
		controller.appendInput(
			{ type: "input", text: "Repair PILOT-17 before completing anything", source: "extension" },
			ctx,
		);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Repair PILOT-17" } });
		expect(requests).toEqual([
			{
				proposedObjective: "Repair PILOT-17",
				userRequest: "Discard the pilot tasks; prove a clean workflow",
			},
		]);
	});

	it("does not reuse another session's user request", async () => {
		const { controller, requests, ctx } = captureReviews();
		controller.appendInput({ type: "input", text: "Repair a particular task", source: "interactive" }, ctx);
		const other = { sessionManager: { getSessionId: () => "different-session" } } as ExtensionContext;
		await controller.review({
			ctx: other,
			kind: "goal_set_review",
			payload: { proposedObjective: "Prove a clean workflow" },
		});
		expect(requests).toEqual([{ proposedObjective: "Prove a clean workflow" }]);
	});

	it("retains each session's genuine request when sessions interleave", async () => {
		const { controller, requests, ctx } = captureReviews();
		const other = { sessionManager: { getSessionId: () => "different-session" } } as ExtensionContext;
		controller.appendInput({ type: "input", text: "Prove a clean workflow", source: "interactive" }, ctx);
		controller.appendInput({ type: "input", text: "Fix BUG-42", source: "interactive" }, other);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Clean pilot" } });
		expect(requests).toEqual([{ proposedObjective: "Clean pilot", userRequest: "Prove a clean workflow" }]);
	});

	it("does not invent user evidence from an assistant-proposed objective", async () => {
		const { controller, requests, ctx } = captureReviews();
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Repair PILOT-17" } });
		expect(requests).toEqual([{ proposedObjective: "Repair PILOT-17" }]);
	});
});
