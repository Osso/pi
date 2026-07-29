import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	readSupervisorRequest,
	recoverSupervisorRequests,
} from "../src/core/session-control-db.ts";
import { requestSupervisorDecision } from "../src/supervisor/client.ts";

describe("Supervisor client", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-client-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("waits for and returns the durable Supervisor response", async () => {
		const decision = requestSupervisorDecision({
			controlDbPath,
			kind: "approval_review",
			payload: { toolName: "read" },
			pollIntervalMs: 1,
			projectId: "pi",
			senderSessionId: "main",
			timeoutMs: 1_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 1));
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		completeSupervisorRequest(controlDbPath, request.id, "runtime", { kind: "approve", reason: "bounded" });

		await expect(decision).resolves.toEqual({ kind: "approve", reason: "bounded" });
	});

	it("retries a timed-out request before returning a later durable response", async () => {
		const decision = requestSupervisorDecision({
			controlDbPath,
			kind: "goal_idle_review",
			maxAttempts: 2,
			payload: { objective: "finish" },
			pollIntervalMs: 1,
			projectId: "pi",
			retryDelayMs: 1,
			retryJitterRatio: 0,
			senderSessionId: "main",
			timeoutMs: 100,
		});

		let retriedRequestRecord = readSupervisorRequest(controlDbPath, 2);
		for (let attempts = 0; !retriedRequestRecord && attempts < 250; attempts++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
			retriedRequestRecord = readSupervisorRequest(controlDbPath, 2);
		}
		if (!retriedRequestRecord) throw new Error("expected retried request record");
		recoverSupervisorRequests(controlDbPath);
		const retriedRequest = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!retriedRequest) throw new Error("expected claimable retried request");
		completeSupervisorRequest(controlDbPath, retriedRequest.id, "runtime", {
			kind: "continue",
			reason: "recovered",
		});

		await expect(decision).resolves.toEqual({ kind: "continue", reason: "recovered" });
	});

	it("returns error when all request attempts expire without a service response", async () => {
		await expect(
			requestSupervisorDecision({
				controlDbPath,
				kind: "goal_idle_review",
				maxAttempts: 2,
				payload: { objective: "finish" },
				pollIntervalMs: 1,
				projectId: "pi",
				retryDelayMs: 1,
				retryJitterRatio: 0,
				senderSessionId: "main",
				timeoutMs: 20,
			}),
		).resolves.toMatchObject({ kind: "error", reason: "Supervisor request timed out after 2 attempts" });
	});
});
