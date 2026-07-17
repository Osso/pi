import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readRuntimeMailboxListener } from "../../../src/core/session-control-db.ts";
import { withHeadlessPi } from "../headless-pi.ts";

interface ParentAgentRecord {
	type: "custom";
	customType: "agent_start" | "agent_complete";
	data?: {
		agentId?: string;
		childSessionId?: string;
		lifecycle?: string;
		transcriptPath?: string;
	};
}

function readParentAgentRecord(
	sessionFile: string,
	customType: ParentAgentRecord["customType"],
	agentId: string,
): ParentAgentRecord | undefined {
	return readFileSync(sessionFile, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as unknown)
		.find(
			(entry): entry is ParentAgentRecord =>
				typeof entry === "object" &&
				entry !== null &&
				"type" in entry &&
				entry.type === "custom" &&
				"customType" in entry &&
				entry.customType === customType &&
				"data" in entry &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				"agentId" in entry.data &&
				entry.data.agentId === agentId,
		);
}

function removeParentAgentRecords(sessionFile: string, agentId: string): void {
	const retained = readFileSync(sessionFile, "utf8")
		.trimEnd()
		.split("\n")
		.filter((line) => {
			const entry = JSON.parse(line) as Partial<ParentAgentRecord>;
			return !(entry.type === "custom" && entry.data?.agentId === agentId);
		});
	writeFileSync(sessionFile, `${retained.join("\n")}\n`, "utf8");
}

async function waitForParentAgentRecord(
	sessionFile: string,
	customType: ParentAgentRecord["customType"],
	agentId: string,
): Promise<ParentAgentRecord> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const record = readParentAgentRecord(sessionFile, customType, agentId);
		if (record) return record;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${customType} record for ${agentId} in ${sessionFile}`);
}

describe("sub-agent parent JSONL restart recovery", () => {
	it("keeps a spawned child visible and its listener alive through completion report routing", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Spawn a child and inspect it immediately" });
			const initialMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				initialMainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Immediate visibility child",
						prompt: "Wait, then return: visibility complete",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Immediate visibility child");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Immediate visibility child has no child session ID");
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const childRecipient = { agentId: spawned.id, sessionId: childSessionId };
			const parentRecipient = { agentId: null, sessionId: pi.sessionId };
			expect(readRuntimeMailboxListener(controlDbPath, childRecipient)).toBeDefined();
			expect(readRuntimeMailboxListener(controlDbPath, parentRecipient)).toBeDefined();

			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMainRequest.id,
			);
			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
			);
			const listResult = await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "list_agents",
			);
			expect(JSON.stringify(listResult)).toContain(spawned.id);
			const mainAfterList = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainAfterSpawn.id,
			);
			pi.respondToLlmRequest(mainAfterList.id, fauxAssistantMessage("Child remains visible"));

			pi.respondToLlmRequest(childRequest.id, fauxAssistantMessage("visibility complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			expect(readRuntimeMailboxListener(controlDbPath, childRecipient)).toBeUndefined();
			expect(readRuntimeMailboxListener(controlDbPath, parentRecipient)).toBeDefined();

			const completionRequest = await pi.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.userMessages.some((message) => message.includes("visibility complete")),
			);
			expect(completionRequest.userMessages).toContainEqual(expect.stringContaining("visibility complete"));
			pi.respondToLlmRequest(completionRequest.id, fauxAssistantMessage("Completion report received"));
		});
	});

	it("steers a live child with a registered listener without restarting Pi", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child, then steer it without restarting" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Live steering target",
						prompt: "Wait for steering",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Live steering target");
			const initialChildRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Live steering target has no child session ID");
			const recipient = { agentId: spawned.id, sessionId: childSessionId };
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const beforeSteer = pi.listAgents().find((agent) => agent.id === spawned.id);
			const listenerBeforeSteer = readRuntimeMailboxListener(controlDbPath, recipient);
			expect(beforeSteer?.lifecycle).toBe("running");
			expect(listenerBeforeSteer).toBeDefined();

			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", {
						agentId: spawned.id,
						message: "Apply this live steering message",
					}),
					{ stopReason: "toolUse" },
				),
			);
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "steering_pending");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeDefined();
			pi.respondToLlmRequest(initialChildRequest.id, fauxAssistantMessage("Initial child turn complete"));
			const steeredRequest = await pi.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== initialChildRequest.id,
			);
			expect(steeredRequest.userMessages).toContainEqual(
				expect.stringContaining("Apply this live steering message"),
			);
			pi.respondToLlmRequest(steeredRequest.id, fauxAssistantMessage("Steering delivered"));
		});
	});

	it("reports a terminal child as inactive when its listener retires before a stale steering request", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child that completes before stale steering" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", { displayName: "Terminal steering target", prompt: "Complete now" }),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Terminal steering target");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Terminal steering target has no child session ID");
			const recipient = { agentId: spawned.id, sessionId: childSessionId };
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("running");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeDefined();

			pi.respondToLlmRequest(childRequest.id, fauxAssistantMessage("Completed before steering"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("completed");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeUndefined();

			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(
					fauxToolCall("steer_agent", { agentId: spawned.id, message: "This steering is stale" }),
					{ stopReason: "toolUse" },
				),
			);
			const steerResult = await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "steer_agent",
			);
			expect(JSON.stringify(steerResult)).toContain("inactive");
			expect(JSON.stringify(steerResult)).not.toContain("mutation_mismatch");
		});
	});

	it("reconstructs the same child from parent start and completion records after a supervisor crash", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a reviewer that survives restart" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Restart-persisted reviewer",
						prompt: "Review until Pi restarts",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Restart-persisted reviewer");
			const childSessionId = spawned.transcript?.sessionId;
			const transcriptPath = spawned.transcript?.path;
			expect(childSessionId).toBeDefined();
			expect(transcriptPath).toBeDefined();
			const startRecord = await waitForParentAgentRecord(pi.sessionFile, "agent_start", spawned.id);
			expect(startRecord.data).toMatchObject({
				agentId: spawned.id,
				childSessionId,
				lifecycle: "running",
				transcriptPath,
			});

			const interruptedRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			await pi.crash();
			await pi.restart();

			const restoredRequest = await pi.waitForLlmRequest(
				(request) => request.agentId === spawned.id && request.id !== interruptedRequest.id,
			);
			const restored = pi.listAgents().find((agent) => agent.id === spawned.id);
			expect(restored).toMatchObject({
				id: spawned.id,
				transcript: { sessionId: childSessionId, path: transcriptPath },
			});

			const restoredMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(restoredMainRequest.id, fauxAssistantMessage("Supervisor restored"));
			pi.respondToLlmRequest(restoredRequest.id, fauxAssistantMessage("Recovered review complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");

			const completionRecord = await waitForParentAgentRecord(pi.sessionFile, "agent_complete", spawned.id);
			expect(completionRecord.data).toMatchObject({
				agentId: spawned.id,
				childSessionId,
				lifecycle: "completed",
				transcriptPath,
			});
		});
	});

	it("fails a dead-owned child that has no parent restart journal record", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a legacy unjournaled child" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", { displayName: "Unjournaled child", prompt: "Wait for restart" }),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Unjournaled child");
			await waitForParentAgentRecord(pi.sessionFile, "agent_start", spawned.id);
			await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			await pi.crash();
			removeParentAgentRecords(pi.sessionFile, spawned.id);
			await pi.restart();

			const failed = await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "failed");
			expect(failed.error).toMatchObject({ code: "lost_runtime" });
			const recovered = await Promise.race([
				pi.waitForLlmRequest((request) => request.agentId === spawned.id).then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
			]);
			expect(recovered).toBe(false);
		});
	});

	it("records a failed child in the parent JSONL when restart reconstruction cannot open its transcript", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child whose transcript will be lost" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", { displayName: "Failing child", prompt: "Wait for restart" }),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Failing child");
			await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const transcriptPath = spawned.transcript?.path;
			if (!transcriptPath) throw new Error("Failing child has no transcript path");
			await pi.crash();
			unlinkSync(transcriptPath);
			await pi.restart();
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "failed");
			const record = await waitForParentAgentRecord(pi.sessionFile, "agent_complete", spawned.id);
			expect(record.data).toMatchObject({ agentId: spawned.id, lifecycle: "failed" });
		});
	});

	it("records an aborted child in the parent JSONL", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start and cancel a child" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", { displayName: "Cancelled child", prompt: "Wait for cancellation" }),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Cancelled child");
			await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const afterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			pi.respondToLlmRequest(
				afterSpawn.id,
				fauxAssistantMessage(fauxToolCall("cancel_agent", { agentId: spawned.id }), { stopReason: "toolUse" }),
			);
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "aborted");
			const record = await waitForParentAgentRecord(pi.sessionFile, "agent_complete", spawned.id);
			expect(record.data).toMatchObject({ agentId: spawned.id, lifecycle: "aborted" });
		});
	});

	it("does not recover a child whose parent JSONL has a completion record", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Complete a child before restart" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", { displayName: "Completed child", prompt: "Complete now" }),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Completed child");
			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			pi.respondToLlmRequest(childRequest.id, fauxAssistantMessage("Done before restart"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			await waitForParentAgentRecord(pi.sessionFile, "agent_complete", spawned.id);

			await pi.crash();
			await pi.restart();
			const restoredMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(restoredMainRequest.id, fauxAssistantMessage("Supervisor restored"));
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("completed");
			const recovered = await Promise.race([
				pi
					.waitForLlmRequest((request) => request.agentId === spawned.id)
					.then(() => true)
					.catch(() => false),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
			]);
			expect(recovered).toBe(false);
		});
	});
});
