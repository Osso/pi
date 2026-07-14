import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
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

	it("returns error when the deadline expires without a service response", async () => {
		await expect(
			requestSupervisorDecision({
				controlDbPath,
				kind: "goal_idle_review",
				payload: { objective: "finish" },
				pollIntervalMs: 1,
				projectId: "pi",
				senderSessionId: "main",
				timeoutMs: 5,
			}),
		).resolves.toMatchObject({ kind: "error", reason: "Supervisor request timed out" });
	});
});
