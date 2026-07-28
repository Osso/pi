import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
	recoverSupervisorRequests,
	requeueSupervisorRequest,
} from "../src/core/session-control-db.ts";

describe("Supervisor request repository", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-request-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
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
		if (!claimed?.claimToken) throw new Error("expected claimed advisory");

		expect(() =>
			completeSupervisorRequest(controlDbPath, requestId, claimed.claimToken, {
				kind: "continue",
				reason: "binding responses are forbidden",
				instructions: "Do work",
			}),
		).toThrow("Invalid Supervisor response kind continue for supervisor_advisory");
		completeSupervisorRequest(controlDbPath, requestId, claimed.claimToken, {
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
