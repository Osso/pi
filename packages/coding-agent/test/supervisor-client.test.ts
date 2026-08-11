import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	readSupervisorRequest,
	recoverSupervisorRequests,
} from "../src/core/session-control-db.ts";
import { requestSupervisorDecision } from "../src/supervisor/client.ts";

const runningSupervisor = {
	version: VERSION,
	pid: 1234,
	executable: "/usr/local/bin/pi",
	instanceId: "supervisor-instance",
	managedBy: "pi" as const,
	ready: true as const,
};
const runningDependencies = { ensureRunning: async () => runningSupervisor };

describe("Supervisor client", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-client-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("ensures the resident Supervisor is running before posting a request", async () => {
		const ensureRunning = vi.fn(async () => runningSupervisor);
		const decision = requestSupervisorDecision(
			{
				controlDbPath,
				kind: "approval_review",
				payload: { toolName: "read" },
				pollIntervalMs: 1,
				projectId: "pi",
				senderSessionId: "main",
				timeoutMs: 1_000,
			},
			{ ensureRunning },
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		completeSupervisorRequest(controlDbPath, request.id, "runtime", { kind: "approve", reason: "bounded" });

		await expect(decision).resolves.toEqual({ kind: "approve", reason: "bounded" });
		expect(ensureRunning).toHaveBeenCalledOnce();
		expect(ensureRunning).toHaveBeenCalledWith({ controlDbPath });
	});

	it("returns a typed error without posting when Supervisor startup fails", async () => {
		await expect(
			requestSupervisorDecision(
				{
					controlDbPath,
					kind: "approval_review",
					payload: { toolName: "write" },
					pollIntervalMs: 1,
					projectId: "pi",
					senderSessionId: "main",
					timeoutMs: 20,
				},
				{
					ensureRunning: async () => {
						throw new Error("spawn denied");
					},
				},
			),
		).resolves.toEqual({ kind: "error", reason: "Supervisor startup failed: spawn denied" });
		expect(readSupervisorRequest(controlDbPath, 1)).toBeUndefined();
	});

	it("waits for and returns the durable Supervisor response", async () => {
		const decision = requestSupervisorDecision(
			{
				controlDbPath,
				kind: "approval_review",
				payload: { toolName: "read" },
				pollIntervalMs: 1,
				projectId: "pi",
				senderSessionId: "main",
				timeoutMs: 1_000,
			},
			runningDependencies,
		);
		await new Promise((resolve) => setTimeout(resolve, 1));
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		completeSupervisorRequest(controlDbPath, request.id, "runtime", { kind: "approve", reason: "bounded" });

		await expect(decision).resolves.toEqual({ kind: "approve", reason: "bounded" });
	});

	it("retries a timed-out request before returning a later durable response", async () => {
		vi.useFakeTimers();
		const decision = requestSupervisorDecision(
			{
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
			},
			runningDependencies,
		);

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(1);
		if (!readSupervisorRequest(controlDbPath, 2)) throw new Error("expected retried request record");

		recoverSupervisorRequests(controlDbPath);
		const retriedRequest = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!retriedRequest) throw new Error("expected claimable retried request");
		completeSupervisorRequest(controlDbPath, retriedRequest.id, "runtime", {
			instructions: "Continue the goal.",
			kind: "continue",
			reason: "recovered",
		});

		await vi.advanceTimersByTimeAsync(1);
		await expect(decision).resolves.toEqual({
			instructions: "Continue the goal.",
			kind: "continue",
			reason: "recovered",
		});
	});

	it("returns error when all request attempts expire without a service response", async () => {
		await expect(
			requestSupervisorDecision(
				{
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
				},
				runningDependencies,
			),
		).resolves.toMatchObject({ kind: "error", reason: "Supervisor request timed out after 2 attempts" });
	});
});
