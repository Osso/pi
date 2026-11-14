import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelSupervisorRequest,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
	recoverSupervisorRequests,
	requeueSupervisorRequest,
} from "../src/core/session-control-db.ts";

function goalRoute(requestId: string) {
	return { sessionId: "goal-session", agentId: null, requestId };
}

describe("Supervisor request repository", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-request-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("deletes completed and cancelled requests 24 hours after they finish", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
		const request = (objective: string) =>
			postSupervisorRequest(controlDbPath, {
				deadlineAt: "2026-12-01T00:00:00.000Z",
				kind: "goal_idle_review",
				payload: { objective },
				projectId: "pi",
				replyTo: { sessionId: "goal-session", agentId: null, requestId: objective },
				senderSessionId: "goal-session",
			});
		const complete = (requestId: number) => {
			const claimed = claimNextSupervisorRequest(controlDbPath, `runtime-${requestId}`);
			if (claimed?.id !== requestId || !claimed.claimToken) throw new Error(`expected claim of ${requestId}`);
			completeSupervisorRequest(controlDbPath, requestId, claimed.claimToken, { kind: "pause", reason: "done" });
		};
		const oldCompleted = request("old completed");
		complete(oldCompleted);
		const oldCancelled = request("old cancelled");
		cancelSupervisorRequest(controlDbPath, goalRoute("old cancelled"), "Escape pressed");
		const oldPending = request("old pending");

		vi.setSystemTime(new Date("2026-11-01T23:59:00.000Z"));
		const recentCancelled = request("recent cancelled");
		cancelSupervisorRequest(controlDbPath, goalRoute("recent cancelled"), "Escape pressed");
		expect(readSupervisorRequest(controlDbPath, oldCompleted)).toMatchObject({ status: "completed" });

		vi.setSystemTime(new Date("2026-11-02T00:00:30.000Z"));
		expect(readSupervisorRequest(controlDbPath, oldCompleted)).toBeUndefined();
		expect(readSupervisorRequest(controlDbPath, oldCancelled)).toBeUndefined();
		expect(readSupervisorRequest(controlDbPath, oldPending)).toMatchObject({ status: "pending" });
		expect(readSupervisorRequest(controlDbPath, recentCancelled)).toMatchObject({ status: "cancelled" });
	});

	it("claims policy requests before older advisory requests", () => {
		const advisoryId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:03:00.000Z",
			kind: "supervisor_advisory" as never,
			payload: { question: "Is this evidence sufficient?" },
			projectId: "pi",
			senderSessionId: "advisory-session",
		});
		const goalId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:02:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "ship supervisor" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		const approvalId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:00:30.000Z",
			kind: "approval_review",
			payload: { toolName: "write" },
			projectId: "pi",
			senderSessionId: "approval-session",
		});

		const approval = claimNextSupervisorRequest(controlDbPath, "approval-runtime");
		expect(approval).toMatchObject({ id: approvalId, kind: "approval_review" });
		if (!approval?.claimToken) throw new Error("expected claimed approval");
		completeSupervisorRequest(controlDbPath, approval.id, approval.claimToken, { kind: "approve", reason: "safe" });

		const goal = claimNextSupervisorRequest(controlDbPath, "goal-runtime");
		expect(goal).toMatchObject({ id: goalId, kind: "goal_idle_review" });
		if (!goal?.claimToken) throw new Error("expected claimed goal");
		completeSupervisorRequest(controlDbPath, goal.id, goal.claimToken, { kind: "pause", reason: "done" });

		expect(claimNextSupervisorRequest(controlDbPath, "advisory-runtime")).toMatchObject({
			id: advisoryId,
			kind: "supervisor_advisory",
		});
	});

	it("persists only advisory responses for advisory requests", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:03:00.000Z",
			kind: "supervisor_advisory" as never,
			payload: { context: "Scoped evidence", question: "What is missing?" },
			projectId: "pi",
			senderSessionId: "main-session",
		});
		const claimed = claimNextSupervisorRequest(controlDbPath, "supervisor-runtime");
		const claimToken = claimed?.claimToken;
		if (!claimToken) throw new Error("expected claimed advisory");

		expect(() =>
			completeSupervisorRequest(controlDbPath, requestId, claimToken, {
				kind: "continue",
				reason: "binding responses are forbidden",
				instructions: "Do work",
			}),
		).toThrow("Invalid Supervisor response kind continue for supervisor_advisory");
		completeSupervisorRequest(controlDbPath, requestId, claimToken, {
			kind: "advisory",
			answer: "The evidence is sufficient.",
		} as never);
		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "advisory", answer: "The evidence is sufficient." },
			status: "completed",
		});
	});

	it("claims approval requests before older goal requests", () => {
		const goalId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:02:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "ship supervisor" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		const approvalId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:00:30.000Z",
			kind: "approval_review",
			payload: { toolName: "write" },
			projectId: "pi",
			senderSessionId: "approval-session",
		});

		expect(claimNextSupervisorRequest(controlDbPath, "supervisor-runtime")).toMatchObject({
			id: approvalId,
			kind: "approval_review",
			status: "claimed",
		});
		expect(claimNextSupervisorRequest(controlDbPath, "supervisor-runtime")).toBeUndefined();
		expect(readSupervisorRequest(controlDbPath, goalId)).toMatchObject({ status: "pending" });
	});

	it("requeues an interrupted goal request without changing its evidence or deadline", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:02:00.000Z",
			kind: "goal_completion_review",
			payload: { objective: "ship supervisor", reason: "tests pass" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		const claimed = claimNextSupervisorRequest(controlDbPath, "supervisor-runtime");
		if (!claimed) throw new Error("expected claimed request");

		requeueSupervisorRequest(controlDbPath, requestId, "supervisor-runtime");

		expect(claimNextSupervisorRequest(controlDbPath, "supervisor-runtime-2")).toMatchObject({
			deadlineAt: "2026-07-14T12:02:00.000Z",
			id: requestId,
			kind: "goal_completion_review",
			payload: { objective: "ship supervisor", reason: "tests pass" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
	});

	it("recovers claimed requests after a Supervisor process restart", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 120_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		claimNextSupervisorRequest(controlDbPath, "dead-runtime");

		recoverSupervisorRequests(controlDbPath);

		expect(claimNextSupervisorRequest(controlDbPath, "replacement-runtime")).toMatchObject({ id: requestId });
	});

	it("persists a pause response for a waiting goal caller", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-17T12:03:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "wait for input" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		claimNextSupervisorRequest(controlDbPath, "supervisor-runtime");

		completeSupervisorRequest(controlDbPath, requestId, "supervisor-runtime", {
			kind: "pause",
			reason: "waiting for user input",
		});

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "pause", reason: "waiting for user input" },
			status: "completed",
		});
	});

	it("persists a wait response for a waiting goal caller", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-20T12:03:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "wait for an active agent" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		claimNextSupervisorRequest(controlDbPath, "supervisor-runtime");

		completeSupervisorRequest(controlDbPath, requestId, "supervisor-runtime", {
			kind: "wait",
			reason: "agent still active",
		});

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "wait", reason: "agent still active" },
			status: "completed",
		});
	});

	it("rejects a pause response for an approval request", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-17T12:00:30.000Z",
			kind: "approval_review",
			payload: { toolName: "read" },
			projectId: "pi",
			senderSessionId: "main-session",
		});
		claimNextSupervisorRequest(controlDbPath, "supervisor-runtime");

		expect(() =>
			completeSupervisorRequest(controlDbPath, requestId, "supervisor-runtime", {
				kind: "pause",
				reason: "not valid for approval",
			}),
		).toThrow("Invalid Supervisor response kind pause for approval_review");
		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({ status: "claimed" });
	});

	it("cancels pending and claimed requests without allowing claim or late completion", () => {
		const pendingId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-08-13T12:03:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "keep active" },
			projectId: "pi",
			replyTo: goalRoute("pending"),
			senderSessionId: "goal-session",
		});

		expect(cancelSupervisorRequest(controlDbPath, goalRoute("pending"), "Escape pressed")).toBe(true);
		expect(readSupervisorRequest(controlDbPath, pendingId)).toMatchObject({
			status: "cancelled",
			response: { kind: "error", reason: "Escape pressed" },
		});
		expect(claimNextSupervisorRequest(controlDbPath, "runtime")).toBeUndefined();
		expect(cancelSupervisorRequest(controlDbPath, goalRoute("pending"), "again")).toBe(false);

		const claimedId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-08-13T12:03:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "keep active" },
			projectId: "pi",
			replyTo: goalRoute("claimed"),
			senderSessionId: "goal-session",
		});
		const claimed = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!claimed?.claimToken) throw new Error("expected claimed request");

		expect(cancelSupervisorRequest(controlDbPath, goalRoute("claimed"), "Escape pressed")).toBe(true);
		expect(() =>
			completeSupervisorRequest(controlDbPath, claimedId, claimed.claimToken as string, {
				kind: "continue",
				instructions: "stale",
				reason: "late",
			}),
		).toThrow(`Supervisor request claim lost: ${claimedId}`);
		expect(readSupervisorRequest(controlDbPath, claimedId)).toMatchObject({ status: "cancelled" });
	});

	it("persists a typed response for the waiting caller", () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-07-14T12:00:30.000Z",
			kind: "approval_review",
			payload: { toolName: "read" },
			projectId: "pi",
			senderSessionId: "main-session",
		});
		claimNextSupervisorRequest(controlDbPath, "supervisor-runtime");

		completeSupervisorRequest(controlDbPath, requestId, "supervisor-runtime", {
			kind: "approve",
			reason: "Read-only inspection is bounded.",
		});

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "approve", reason: "Read-only inspection is bounded." },
			status: "completed",
		});
	});
});
