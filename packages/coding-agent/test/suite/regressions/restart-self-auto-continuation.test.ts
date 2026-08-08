import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, readMultiAgentRuntimeOwnership } from "../../../src/core/session-control-db.ts";
import { type HeadlessLlmRequest, type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

async function persistCompletedEndTurn(pi: HeadlessPi): Promise<void> {
	await pi.send({ type: "prompt", message: "Finish this turn before process restart" });
	const request = await pi.waitForLlmRequest((candidate) => candidate.agentId === null);
	await completeParentTurn(pi, request.id, "Turn completed before restart");
}

async function completeParentTurn(pi: HeadlessPi, requestId: string, reason: string): Promise<void> {
	pi.respondToLlmRequest(
		requestId,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" }),
	);
	await pi.waitForSessionEntry(
		null,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "end_turn" &&
			JSON.stringify(entry.message).includes(reason),
	);
}

function configureSmallCompactionWindow(pi: HeadlessPi): void {
	const settingsPath = join(pi.paths.agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	writeFileSync(
		settingsPath,
		JSON.stringify({
			...settings,
			compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 },
		}),
		"utf8",
	);
}

async function completeChildTextResponse(
	pi: HeadlessPi,
	agentId: string,
	requestId: string,
	text: string,
	endTurnReason: string,
): Promise<void> {
	pi.respondToLlmRequest(requestId, fauxAssistantMessage(text));
	const endTurnRequest = await pi.waitForLlmRequest(
		(request) =>
			request.agentId === agentId &&
			request.id !== requestId &&
			request.userMessages.some((message) => message.includes("Your previous response was already delivered")),
	);
	pi.respondToLlmRequest(
		endTurnRequest.id,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason: endTurnReason }), { stopReason: "toolUse" }),
	);
}

function replaceLatestParentAgentStartWithLegacyMarker(pi: HeadlessPi, agentId: string): void {
	const lines = readFileSync(pi.sessionFile, "utf8").trimEnd().split("\n");
	const entries = lines.map(
		(line) => JSON.parse(line) as { type?: string; customType?: string; data?: { agentId?: string } },
	);
	const startIndexes = entries.flatMap((entry, index) =>
		entry.type === "custom" && entry.customType === "agent_start" && entry.data?.agentId === agentId ? [index] : [],
	);
	const latestStartIndex = startIndexes.at(-1);
	if (latestStartIndex === undefined) throw new Error(`No parent agent_start record found for ${agentId}`);
	const latestStart = entries[latestStartIndex];
	if (!latestStart) throw new Error(`Parent agent_start record ${latestStartIndex} is missing`);
	entries[latestStartIndex] = { ...latestStart, customType: "legacy_compacted_agent_start" };
	writeFileSync(pi.sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function waitForMainRequest(pi: HeadlessPi, timeoutMs?: number) {
	return pi.waitForLlmRequest((request) => request.agentId === null, timeoutMs);
}

function waitForChildRequest(pi: HeadlessPi, agentId: string, timeoutMs?: number) {
	return pi.waitForLlmRequest((request) => request.agentId === agentId, timeoutMs);
}

function waitForAgentLifecycle(pi: HeadlessPi, agentId: string, lifecycle: "steering_pending" | "aborted") {
	return pi.waitForAgent((agent) => agent.id === agentId && agent.lifecycle === lifecycle);
}

function waitForMainToolResult(pi: HeadlessPi, toolName: string) {
	return pi.waitForSessionEntry(
		null,
		(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName,
	);
}

function waitForSteeredChildRequest(pi: HeadlessPi, agentId: string) {
	return pi.waitForLlmRequest(
		(request) =>
			request.agentId === agentId &&
			request.userMessages.some((message) => message.includes("Finish the compacted recovery after restart")),
	);
}

function expectOneActiveParentAgentStart(pi: HeadlessPi, agentId: string): void {
	const activeStarts = pi.readSessionEntries(null).filter((entry) => {
		if (entry.type !== "custom" || entry.customType !== "agent_start") return false;
		const data = entry.data as { agentId?: unknown } | undefined;
		return data?.agentId === agentId;
	});
	expect(activeStarts).toHaveLength(1);
}

function expectFailedToolResult(request: HeadlessLlmRequest, toolName: string, errorMessage: string): void {
	const results = request.messages.filter(
		(message) => message.role === "toolResult" && message.toolName === toolName,
	);
	expect(results).toHaveLength(1);
	expect(results[0]).toMatchObject({ isError: true });
	expect(JSON.stringify(results[0])).toContain(errorMessage);
}

it("automatically continues the restored session after restart_self", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Restart and then continue automatically" });
		const beforeRestart = await pi.waitForLlmRequest((request) => request.agentId === null);

		pi.respondToLlmRequest(
			beforeRestart.id,
			fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
		);

		const afterRestart = await pi.waitForLlmRequest((request) => request.agentId === null, 10_000);
		expect(afterRestart.sessionId).toBe(pi.sessionId);
		expect(JSON.stringify(afterRestart.messages)).not.toContain("Continue from the restored session after restart.");
		const restoredEntries = pi.readSessionEntries(null);
		expect(
			restoredEntries.filter((entry) => entry.type === "custom_message" && entry.customType === "self_restart"),
		).toHaveLength(1);
		expect(restoredEntries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(
			1,
		);

		pi.respondToLlmRequest(afterRestart.id, fauxAssistantMessage("continued"));
		await pi.waitForSessionEntry(
			null,
			(entry) => entry.type === "message" && JSON.stringify(entry.message).includes("continued"),
		);
	});
}, 30_000);

it("rejects child restart_self without replacing the supervisor session", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Spawn a child that attempts to restart Pi" });
		const initialMain = await waitForMainRequest(pi);
		pi.respondToLlmRequest(
			initialMain.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Restarting child",
					prompt: "Attempt restart_self while remaining a child",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await pi.waitForAgent((agent) => agent.displayName === "Restarting child");
		const childSessionId = child.transcript?.sessionId;
		if (!childSessionId) throw new Error("Spawned child has no transcript session ID");
		const initialChild = await waitForChildRequest(pi, child.id);
		const mainAfterSpawn = await pi.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== initialMain.id,
		);

		pi.respondToLlmRequest(
			initialChild.id,
			fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
		);
		const childAfterRejection = await pi.waitForLlmRequest(
			(request) => request.id !== initialChild.id && (request.agentId === child.id || request.agentId === null),
			10_000,
		);

		expect(childAfterRejection.agentId).toBe(child.id);
		expect(childAfterRejection.sessionId).toBe(childSessionId);
		expectFailedToolResult(childAfterRejection, "restart_self", "Child agent runtimes cannot restart Pi");
		expect(
			pi
				.readSessionEntries(child.id)
				.filter((entry) => entry.type === "custom_message" && entry.customType === "self_restart"),
		).toHaveLength(0);

		pi.respondToLlmRequest(
			mainAfterSpawn.id,
			fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
		);
		const mainAfterRestart = await pi.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== mainAfterSpawn.id,
			10_000,
		);
		const childAfterSupervisorRestart = await pi.waitForLlmRequest(
			(request) => request.agentId === child.id && request.id !== childAfterRejection.id,
			10_000,
		);

		expect(mainAfterRestart.sessionId).toBe(pi.sessionId);
		expect(childAfterSupervisorRestart.sessionId).toBe(childSessionId);
		expect(
			pi
				.readSessionEntries(null)
				.filter((entry) => entry.type === "custom_message" && entry.customType === "self_restart"),
		).toHaveLength(1);
		expect(
			pi
				.readSessionEntries(child.id)
				.filter((entry) => entry.type === "custom_message" && entry.customType === "self_restart"),
		).toHaveLength(0);
	});
}, 30_000);

it("keeps a completed turn idle after process restart without a running goal", async () => {
	await withHeadlessPi(async (pi) => {
		await persistCompletedEndTurn(pi);

		await pi.restart();

		await expect(pi.waitForLlmRequest((request) => request.agentId === null, 1_000)).rejects.toThrow(
			"Timed out waiting for LLM request",
		);
	});
}, 30_000);

it("continues a completed running goal after restart while a child remains live", async () => {
	await withHeadlessPi(async (pi) => {
		await pi.send({ type: "prompt", message: "Spawn a child, then complete the main turn" });
		const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
		pi.respondToLlmRequest(
			mainRequest.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Resume policy child",
					prompt: "Wait across restart",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await pi.waitForAgent((agent) => agent.displayName === "Resume policy child");
		const initialChildRequest = await pi.waitForLlmRequest((request) => request.agentId === child.id);
		const mainAfterSpawn = await pi.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== mainRequest.id,
		);
		pi.respondToLlmRequest(
			mainAfterSpawn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Main turn completed" }), {
				stopReason: "toolUse",
			}),
		);
		await pi.waitForSessionEntry(
			null,
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
		);
		pi.writeRunningGoal("Continue after restoring this session");

		await pi.restart();

		const continuation = await pi.waitForLlmRequest((request) => request.agentId === null, 10_000);
		const restoredChildRequest = await pi.waitForLlmRequest(
			(request) => request.agentId === child.id && request.id !== initialChildRequest.id,
			10_000,
		);
		expect(continuation.sessionId).toBe(pi.sessionId);
		expect(restoredChildRequest.userMessages).toContain("Wait across restart");
		expect(pi.listAgents().find((agent) => agent.id === child.id)?.lifecycle).toBe("running");
	});
}, 30_000);

it("recovers and cancels a compacted logical child after restart_self changes the supervisor incarnation", async () => {
	await withHeadlessPi(async (pi) => {
		configureSmallCompactionWindow(pi);
		await pi.restart();
		await pi.send({ type: "prompt", message: "Spawn a child and restart yourself while it is live" });
		const mainRequest = await waitForMainRequest(pi);
		pi.respondToLlmRequest(
			mainRequest.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Stale logical child",
					prompt: "Remain live through restart",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await pi.waitForAgent((agent) => agent.displayName === "Stale logical child");
		await waitForChildRequest(pi, child.id);
		const mainAfterSpawn = await waitForMainRequest(pi);
		const controlDbPath = getControlDbPath(pi.paths.agentDir);
		await completeParentTurn(pi, mainAfterSpawn.id, "Wait for the child");
		await pi.send({ type: "prompt", message: "Record another parent turn before compaction" });
		const beforeCompaction = await waitForMainRequest(pi, 10_000);
		await completeParentTurn(pi, beforeCompaction.id, "Parent turn before compaction complete");

		const compaction = pi.send({ type: "compact" });
		const compactionRequest = await waitForMainRequest(pi, 10_000);
		pi.respondToLlmRequest(compactionRequest.id, fauxAssistantMessage("Child remains active across compaction"));
		const compactionResponse = await compaction;
		expect(compactionResponse).toMatchObject({ command: "compact", success: true });
		await pi.waitForSessionEntry(null, (entry) => entry.type === "compaction");
		replaceLatestParentAgentStartWithLegacyMarker(pi, child.id);

		await pi.send({ type: "prompt", message: "Queue steering for the compacted child" });
		const steerRequest = await waitForMainRequest(pi);
		pi.respondToLlmRequest(
			steerRequest.id,
			fauxAssistantMessage(
				fauxToolCall("steer_agent", {
					agentId: child.id,
					message: "Finish the compacted recovery after restart",
				}),
				{ stopReason: "toolUse" },
			),
		);
		await waitForAgentLifecycle(pi, child.id, "steering_pending");
		const mainAfterSteer = await waitForMainRequest(pi);
		await completeParentTurn(pi, mainAfterSteer.id, "Steering queued before restart");
		const ownershipBefore = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, child.id);
		if (!ownershipBefore?.processIdentity) throw new Error("Steered logical child has no runtime ownership");

		await pi.send({ type: "prompt", message: "Restart while the compacted child remains live" });
		const restartRequest = await waitForMainRequest(pi, 10_000);
		pi.respondToLlmRequest(
			restartRequest.id,
			fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
		);
		await pi.waitForSessionEntry(
			null,
			(entry) => entry.type === "custom_message" && entry.customType === "self_restart",
		);
		const restoredChildRequest = await waitForChildRequest(pi, child.id, 10_000);
		expectOneActiveParentAgentStart(pi, child.id);
		const ownershipAfter = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, child.id);
		expect(ownershipAfter?.processIdentity).toMatchObject({
			pid: ownershipBefore.processIdentity.pid,
			startTimeTicks: ownershipBefore.processIdentity.startTimeTicks,
		});
		expect(ownershipAfter?.processIdentity?.incarnation).not.toBe(ownershipBefore.processIdentity.incarnation);

		expect(pi.listAgents().find((agent) => agent.id === child.id)?.lifecycle).toBe("steering_pending");
		await completeChildTextResponse(
			pi,
			child.id,
			restoredChildRequest.id,
			"Recovery turn settled",
			"Recovery prompt handled",
		);
		await waitForSteeredChildRequest(pi, child.id);
		const mainAfterRestart = await waitForMainRequest(pi, 10_000);
		pi.respondToLlmRequest(
			mainAfterRestart.id,
			fauxAssistantMessage(
				fauxToolCall("cancel_agent", { agentId: child.id, reason: "Verify recovered cancellation" }),
				{ stopReason: "toolUse" },
			),
		);
		const cancelResult = await waitForMainToolResult(pi, "cancel_agent");
		expect(JSON.stringify(cancelResult)).toContain("Cancelled");
		await waitForAgentLifecycle(pi, child.id, "aborted");

		const mainAfterCancel = await waitForMainRequest(pi);
		pi.respondToLlmRequest(
			mainAfterCancel.id,
			fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
		);
		const listResult = await waitForMainToolResult(pi, "list_agents");
		const serializedListResult = JSON.stringify(listResult);
		expect(serializedListResult).toContain("Found 0 agents.");
		expect(serializedListResult).not.toContain(child.id);
		const mainAfterList = await waitForMainRequest(pi);
		await completeParentTurn(pi, mainAfterList.id, "Recovered cancellation and listing verified");
	});
}, 30_000);
