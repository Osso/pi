import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	enqueueDetachedPyrunBridgeRequest,
	enqueueDetachedPyrunBridgeResponse,
	parseDetachedPyrunBridgeRequest,
} from "../extensions/pyrun/src/detached-bridge.ts";
import { claimDetachedJobRuntimeCommands } from "../src/core/detached-job-control.ts";
import type { DetachedJobOwnershipIdentity } from "../src/core/detached-job-runner.ts";
import { claimRuntimeMailboxMessages, registerRuntimeMailboxListener } from "../src/core/session-control-db.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached Pyrun bridge", () => {
	it("round trips a durable request and exact-identity response", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-pyrun-bridge-"));
		temporaryDirectories.push(root);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const runnerAddress = { agentId: "agent_1", sessionId: "supervisor-1" };
		const supervisorAddress = { agentId: null, sessionId: "supervisor-1" };
		registerRuntimeMailboxListener(controlDbPath, supervisorAddress, process.pid);
		registerRuntimeMailboxListener(controlDbPath, runnerAddress, process.pid);
		const identity: DetachedJobOwnershipIdentity = {
			jobId: "agent_1",
			owner: { agentId: null, sessionId: "supervisor-1" },
			outputLabel: "Pyrun output",
			processIdentity: testProcessIdentity("runner-1"),
		};
		const requestId = enqueueDetachedPyrunBridgeRequest({
			controlDbPath,
			identity,
			method: "models.scoped",
			params: null,
			runnerAddress,
			sessionPath,
			supervisorAddress,
			toolCallId: "pyrun-call-1",
		});
		const [message] = claimRuntimeMailboxMessages(controlDbPath, supervisorAddress);
		if (!message) throw new Error("Expected bridge request");
		const request = parseDetachedPyrunBridgeRequest(message);
		if (!request) throw new Error("Expected valid bridge request");
		expect(request).toMatchObject({ method: "models.scoped", requestId, toolCallId: "pyrun-call-1" });
		for (const toolCallId of [42, ""]) {
			expect(
				parseDetachedPyrunBridgeRequest({
					...message,
					body: JSON.stringify({ ...request, toolCallId }),
				}),
			).toBeUndefined();
		}

		enqueueDetachedPyrunBridgeResponse({
			controlDbPath,
			request,
			result: [{ id: "model-1" }],
			sessionPath,
			supervisorAddress,
		});
		expect(claimDetachedJobRuntimeCommands(controlDbPath, runnerAddress, identity)).toMatchObject([
			{ command: "respond", requestId, result: [{ id: "model-1" }] },
		]);
	});
});
