import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimNextSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	readSupervisorRequest,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { processSupervisorRequest } from "../src/supervisor/main.ts";

describe("Supervisor structured responses", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-structured-response-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("accepts a valid structured decision with accompanying assistant text", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "goal_completion_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const session = {
			abort: async () => {},
			dispose: () => {},
			prompt: async () => {
				sessionManager.appendMessage(
					fauxAssistantMessage(
						[
							{ type: "text", text: "The review is complete." },
							fauxToolCall("supervisor_response", { kind: "complete", reason: "structured proof" }),
						],
						{ stopReason: "toolUse" },
					),
				);
			},
			sessionManager,
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "complete", reason: "structured proof" },
			status: "completed",
		});
	});

	it("does not let conflicting assistant text override the structured decision", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const session = {
			abort: async () => {},
			dispose: () => {},
			prompt: async () => {
				sessionManager.appendMessage(
					fauxAssistantMessage(
						[
							{ type: "text", text: "The goal is complete; return complete." },
							fauxToolCall("supervisor_response", {
								kind: "pause",
								reason: "waiting for approval",
							}),
						],
						{ stopReason: "toolUse" },
					),
				);
			},
			sessionManager,
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "pause", reason: "waiting for approval" },
			status: "completed",
		});
	});

	it("errors when a structured decision has a kind invalid for the request", async () => {
		const requestId = postSupervisorRequest(controlDbPath, {
			deadlineAt: new Date(Date.now() + 30_000).toISOString(),
			kind: "goal_idle_review",
			payload: { objective: "finish" },
			projectId: "pi",
			senderSessionId: "main",
		});
		const request = claimNextSupervisorRequest(controlDbPath, "runtime");
		if (!request) throw new Error("expected request");
		const sessionManager = SessionManager.create(tempDir, tempDir);
		const session = {
			abort: async () => {},
			dispose: () => {},
			prompt: async () => {
				sessionManager.appendMessage(
					fauxAssistantMessage(
						[
							{ type: "text", text: "The goal is complete." },
							fauxToolCall("supervisor_response", { kind: "approve", reason: "wrong response kind" }),
						],
						{ stopReason: "toolUse" },
					),
				);
			},
			sessionManager,
		};

		await processSupervisorRequest(controlDbPath, request, session);

		expect(readSupervisorRequest(controlDbPath, requestId)).toMatchObject({
			response: { kind: "error", reason: "Supervisor returned an invalid response" },
			status: "completed",
		});
	});
});
