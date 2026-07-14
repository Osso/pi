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
