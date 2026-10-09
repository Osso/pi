import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { enqueueDetachedJobStatusRequest } from "../../src/core/detached-job-control.ts";
import {
	claimRuntimeMailboxMessages,
	getControlDbPath,
	listRuntimeMailboxMessages,
	readMultiAgentRuntimeOwnership,
	registerRuntimeMailboxListener,
} from "../../src/core/session-control-db.ts";
import { withHeadlessPi } from "./headless-pi.ts";

it("routes a fresh detached status request and response after parent restart without rerunning the job", async () => {
	await withHeadlessPi(async (agent) => {
		const startedPath = join(agent.paths.workspaceDir, "status-started");
		const releasePath = join(agent.paths.workspaceDir, "status-release");
		const code = [
			"from pathlib import Path",
			"import time",
			`started = Path(${JSON.stringify(startedPath)})`,
			`release = Path(${JSON.stringify(releasePath)})`,
			'started.write_text((started.read_text() if started.exists() else "") + "x")',
			"while not release.exists(): time.sleep(0.05)",
		].join("\n");
		await agent.send({ type: "prompt", message: "Run the retained status job" });
		const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			initialRequest.id,
			fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
		);
		await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 30_000 });
		void agent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
		const restoredRequest = await agent.waitForLlmRequest(
			(request) =>
				request.agentId === null && JSON.stringify(request.messages).includes("The agent process was restarted"),
		);
		const job = await agent.waitForAgent(
			(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
		);
		expect(restoredRequest.messages.filter((message) => message.role === "toolResult")).toMatchObject([
			{ isError: false, details: { backgroundJobId: job.id } },
		]);
		agent.respondToLlmRequest(
			restoredRequest.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Wait for retained job" }), { stopReason: "toolUse" }),
		);
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const ownership = readMultiAgentRuntimeOwnership(controlDbPath, agent.sessionFile, job.id);
		if (!ownership?.processIdentity || !ownership.owner.sessionId) {
			throw new Error("Expected retained runner ownership");
		}
		const identity = {
			jobId: job.id,
			owner: { agentId: ownership.owner.agentId, sessionId: ownership.owner.sessionId },
			outputLabel: "Pyrun output",
			processIdentity: ownership.processIdentity,
		};
		const requesterAddress = { agentId: null, sessionId: "status-observer" };
		registerRuntimeMailboxListener(controlDbPath, requesterAddress, process.pid);
		const requestId = "status-after-restart";
		const beforeEnqueue = Date.now();
		enqueueDetachedJobStatusRequest({
			controlDbPath,
			identity,
			requesterAddress,
			requestId,
			runnerAddress: { agentId: job.id, sessionId: agent.sessionId },
			sessionPath: agent.sessionFile,
		});
		await vi.waitFor(
			() => {
				expect(
					listRuntimeMailboxMessages(controlDbPath).some(
						(message) => message.recipient.sessionId === requesterAddress.sessionId,
					),
				).toBe(true);
			},
			{ timeout: 10_000 },
		);
		const [response] = claimRuntimeMailboxMessages(controlDbPath, requesterAddress);
		if (!response) throw new Error("Expected retained runner status response");
		expect(Date.parse(response.createdAt)).toBeGreaterThanOrEqual(beforeEnqueue);
		expect(JSON.parse(response.body)).toMatchObject({
			command: "respond",
			identity,
			requestId,
			result: { pendingRequestCount: 0, state: "running" },
		});
		expect(readMultiAgentRuntimeOwnership(controlDbPath, agent.sessionFile, job.id)?.processIdentity).toEqual(
			identity.processIdentity,
		);
		expect(readFileSync(startedPath, "utf8")).toBe("x");
		writeFileSync(releasePath, "release");
		await agent.waitForAgent((candidate) => candidate.id === job.id && candidate.lifecycle === "completed");
	});
}, 90_000);

it("delivers coordinator cancellation after parent restart without injecting a replacement envelope", async () => {
	await withHeadlessPi(async (agent) => {
		const startedPath = join(agent.paths.workspaceDir, "cancel-started");
		const code = [
			"from pathlib import Path",
			"import time",
			`started = Path(${JSON.stringify(startedPath)})`,
			'started.write_text((started.read_text() if started.exists() else "") + "x")',
			"while True: time.sleep(0.05)",
		].join("\n");
		await agent.send({ type: "prompt", message: "Start the cancellation fixture" });
		const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			initialRequest.id,
			fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
		);
		await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 30_000 });
		void agent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
		const restoredRequest = await agent.waitForLlmRequest(
			(request) =>
				request.agentId === null && JSON.stringify(request.messages).includes("The agent process was restarted"),
		);
		const job = await agent.waitForAgent(
			(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
		);
		agent.respondToLlmRequest(
			restoredRequest.id,
			fauxAssistantMessage(fauxToolCall("close_agent", { agentId: job.id, reason: "cancel after restart" }), {
				stopReason: "toolUse",
			}),
		);
		await agent.waitForAgent((candidate) => candidate.id === job.id && candidate.lifecycle === "aborted");
		expect(readFileSync(startedPath, "utf8")).toBe("x");
	});
}, 90_000);
