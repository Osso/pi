import { describe, expect, it } from "vitest";
import { createGoalReviewEvidenceController } from "../extensions/goal/src/goal-review-evidence.ts";
import type { ExtensionContext, RuntimeMailboxEvent, ToolResultEvent } from "../src/core/extensions/types.ts";
import type { RuntimeMailboxMessage } from "../src/core/session-control-db.ts";

// No active goal exists yet: user messages must still reach review.
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

function answeredQuestions(answer: string, flags: { cancelled?: boolean; queued?: boolean } = {}): ToolResultEvent {
	const question = "Which objective?";
	return {
		type: "tool_result",
		toolName: "ask_questions",
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text", text: `User answered questions:\n- ${question} → ${answer}` }],
		isError: false,
		details: {
			blocking: true,
			questions: [{ question }],
			answers: { [question]: answer },
			cancelled: flags.cancelled ?? false,
			queued: flags.queued,
		},
	};
}

const QUEUED_ANSWER = "User answered questions (request q-1):\n- What should deploy.sh do? → Install only";

/** The inbox reply a nonblocking ask_questions call enqueues for its own session. */
function queuedAnswer(overrides: Partial<RuntimeMailboxMessage> = {}): RuntimeMailboxEvent {
	const message: RuntimeMailboxMessage = {
		id: 1,
		kind: "reply",
		body: QUEUED_ANSWER,
		recipient: { sessionId: "user-session", agentId: null },
		sender: { sessionId: "user-session", agentId: null },
		storeRef: { sessionPath: "/sessions/user-session.jsonl", messageId: "ask_questions:q-1" },
		status: "claimed",
		createdAt: "2026-10-23T00:00:00.000Z",
		updatedAt: "2026-10-23T00:00:00.000Z",
		...overrides,
	};
	return { type: "runtime_mailbox", message };
}

describe("Supervisor raw user evidence", () => {
	it("forwards every user message in order so follow-ups extend the first request", async () => {
		const { controller, requests, ctx } = captureReviews();
		controller.appendInput({ type: "input", text: "let's add hotplug", source: "interactive" }, ctx);
		controller.appendInput({ type: "input", text: "also we need rfkill", source: "interactive" }, ctx);
		controller.appendInput(
			{ type: "input", text: "and add deploy.sh", source: "interactive", streamingBehavior: "steer" },
			ctx,
		);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Add deploy.sh" } });
		expect(requests).toEqual([
			{
				proposedObjective: "Add deploy.sh",
				userMessages: ["let's add hotplug", "also we need rfkill", "and add deploy.sh"],
			},
		]);
	});

	it("excludes extension input", async () => {
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
				userMessages: ["Discard the pilot tasks; prove a clean workflow"],
			},
		]);
	});

	it("keeps each session's messages separate when sessions interleave", async () => {
		const { controller, requests, ctx } = captureReviews();
		const other = { sessionManager: { getSessionId: () => "different-session" } } as ExtensionContext;
		controller.appendInput({ type: "input", text: "Prove a clean workflow", source: "interactive" }, ctx);
		controller.appendInput({ type: "input", text: "Fix BUG-42", source: "interactive" }, other);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Clean pilot" } });
		await controller.review({
			ctx: { sessionManager: { getSessionId: () => "third-session" } } as ExtensionContext,
			kind: "goal_set_review",
			payload: { proposedObjective: "Unrelated" },
		});
		expect(requests).toEqual([
			{ proposedObjective: "Clean pilot", userMessages: ["Prove a clean workflow"] },
			{ proposedObjective: "Unrelated" },
		]);
	});

	it("interleaves blocking ask_questions answers with requests in arrival order", async () => {
		const { controller, requests, ctx } = captureReviews();
		controller.appendInput({ type: "input", text: "set goal", source: "interactive" }, ctx);
		controller.appendToolResult(answeredQuestions("Disable shape tracing"), ctx);
		controller.appendInput({ type: "input", text: "Raise the cap instead", source: "interactive" }, ctx);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Raise cap" } });
		expect(requests).toEqual([
			{
				proposedObjective: "Raise cap",
				userMessages: [
					"set goal",
					"User answered questions:\n- Which objective? → Disable shape tracing",
					"Raise the cap instead",
				],
			},
		]);
	});

	it("ignores cancelled and queued ask_questions tool results", async () => {
		const { controller, requests, ctx } = captureReviews();
		controller.appendToolResult(answeredQuestions("Disable shape tracing", { cancelled: true }), ctx);
		controller.appendToolResult(answeredQuestions("Disable shape tracing", { queued: true }), ctx);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Disable tracing" } });
		expect(requests).toEqual([{ proposedObjective: "Disable tracing" }]);
	});

	it("forwards a nonblocking ask_questions answer delivered through the inbox", async () => {
		const { controller, requests, ctx } = captureReviews();
		controller.appendInput({ type: "input", text: "and add deploy.sh", source: "interactive" }, ctx);
		controller.appendMailboxMessage(queuedAnswer(), ctx);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Add deploy.sh" } });
		expect(requests).toEqual([
			{ proposedObjective: "Add deploy.sh", userMessages: ["and add deploy.sh", QUEUED_ANSWER] },
		]);
	});

	it("does not treat other inbox messages as user answers", async () => {
		const { controller, requests, ctx } = captureReviews();
		const otherSession = { sessionId: "other-session", agentId: null };
		controller.appendMailboxMessage(queuedAnswer({ sender: otherSession }), ctx);
		controller.appendMailboxMessage(queuedAnswer({ senderHost: "agent-server" }), ctx);
		controller.appendMailboxMessage(queuedAnswer({ kind: "message" }), ctx);
		controller.appendMailboxMessage(
			queuedAnswer({ storeRef: { sessionPath: "/sessions/user-session.jsonl", messageId: "agent-message-1" } }),
			ctx,
		);
		// answer_question relays the parent agent's JSON answer to a child; not user-typed.
		const relayed = JSON.stringify({ type: "ask_questions_answer", requestId: "q-1", answers: {}, cancelled: false });
		controller.appendMailboxMessage(
			queuedAnswer({
				body: relayed,
				storeRef: { sessionPath: "/sessions/user-session.jsonl", messageId: "ask_questions:child-1:q-1" },
			}),
			ctx,
		);
		controller.appendMailboxMessage(queuedAnswer({ body: "Questions cancelled (request q-1)\n" }), ctx);
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Add deploy.sh" } });
		expect(requests).toEqual([{ proposedObjective: "Add deploy.sh" }]);
	});

	it("keeps the 20 most recent user messages", async () => {
		const { controller, requests, ctx } = captureReviews();
		for (let index = 1; index <= 22; index++) {
			controller.appendInput({ type: "input", text: `message ${index}`, source: "rpc" }, ctx);
		}
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Latest" } });
		const forwarded = requests[0].userMessages as string[];
		expect(forwarded).toHaveLength(20);
		expect(forwarded[0]).toBe("message 3");
		expect(forwarded[19]).toBe("message 22");
	});

	it("does not invent user evidence from an assistant-proposed objective", async () => {
		const { controller, requests, ctx } = captureReviews();
		await controller.review({ ctx, kind: "goal_set_review", payload: { proposedObjective: "Repair PILOT-17" } });
		expect(requests).toEqual([{ proposedObjective: "Repair PILOT-17" }]);
	});
});
