import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

function readTextContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function completedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

async function spawnRelocationBatchChild(agent: HeadlessPi) {
	await agent.send({ type: "prompt", message: "Start a child before relocating" });
	const spawnRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		spawnRequest.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", {
				context: "fresh",
				displayName: "Relocation batch child",
				prompt: "Wait until the parent relocation batch is running",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const spawned = await agent.waitForAgent((candidate) => candidate.displayName === "Relocation batch child");
	const childSessionId = requireHeadlessAgentSessionId(spawned);
	const childRequest = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
	const mainAfterSpawn = await agent.waitForLlmRequest(
		(request) => request.agentId === null && request.id !== spawnRequest.id,
	);
	return { childRequest, mainAfterSpawn, spawnRequest, spawned };
}

async function startBlockedRelocationBatch(
	agent: HeadlessPi,
	mainRequestId: string,
	targetCwd: string,
	releasePath: string,
): Promise<void> {
	const releaseCode = [
		"from pathlib import Path",
		"import time",
		`release = Path(${JSON.stringify(releasePath)})`,
		"while not release.exists():",
		"    time.sleep(0.01)",
		"print('released')",
	].join("\n");
	agent.respondToLlmRequest(
		mainRequestId,
		fauxAssistantMessage(
			[
				{ ...fauxToolCall("pyrun_eval", { code: releaseCode }), id: "hold-before-cwd-relocation" },
				{
					...fauxToolCall("change_working_directory", { path: targetCwd }),
					id: "change-cwd-in-mixed-batch",
				},
			],
			{ stopReason: "toolUse" },
		),
	);
	await agent.waitForEvent(
		(event) =>
			event.type === "tool_execution_start" &&
			event.toolName === "pyrun_eval" &&
			event.toolCallId === "hold-before-cwd-relocation",
	);
}

async function waitForNextMainRequest(agent: HeadlessPi, excludedRequestIds: string[]) {
	const excluded = new Set(excludedRequestIds);
	return agent.waitForLlmRequest((request) => request.agentId === null && !excluded.has(request.id));
}

async function readToolResult(agent: HeadlessPi, toolCallId: string) {
	const entry = await agent.waitForSessionEntry(
		null,
		(candidate) =>
			candidate.type === "message" &&
			candidate.message.role === "toolResult" &&
			candidate.message.toolCallId === toolCallId,
	);
	if (entry.type !== "message" || entry.message.role !== "toolResult") {
		throw new Error(`Expected ${toolCallId} tool result`);
	}
	return entry.message;
}

describe("change_working_directory mixed tool batch", () => {
	it("rebinds the runtime before wait_agent reads relocated mailbox state", async () => {
		await withHeadlessPi(async (agent) => {
			const targetCwd = join(agent.paths.tempDir, "mixed-batch-target");
			const releasePath = join(agent.paths.tempDir, "release-relocation-batch");
			mkdirSync(targetCwd);
			writeFileSync(join(targetCwd, "relocated-marker.txt"), "mixed batch uses relocated runtime");
			const { childRequest, mainAfterSpawn, spawnRequest, spawned } = await spawnRelocationBatchChild(agent);

			await startBlockedRelocationBatch(agent, mainAfterSpawn.id, targetCwd, releasePath);
			agent.respondToLlmRequest(childRequest.id, completedAssistantMessage("Relocation batch child complete"));
			await agent.waitForAgent((candidate) => candidate.id === spawned.id && candidate.lifecycle === "completed");
			writeFileSync(releasePath, "release");
			await agent.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "cwd_changed" &&
					typeof entry.content === "string" &&
					entry.content.includes(targetCwd),
			);

			const afterRelocation = await waitForNextMainRequest(agent, [spawnRequest.id, mainAfterSpawn.id]);
			agent.respondToLlmRequest(
				afterRelocation.id,
				fauxAssistantMessage(
					{ ...fauxToolCall("wait_agent", {}), id: "wait-after-cwd-relocation" },
					{ stopReason: "toolUse" },
				),
			);
			const waitResult = await readToolResult(agent, "wait-after-cwd-relocation");
			expect(waitResult.isError).toBe(false);
			expect(readTextContent(waitResult.content)).not.toContain("Runtime mailbox store reference does not exist");

			const afterWait = await waitForNextMainRequest(agent, [
				spawnRequest.id,
				mainAfterSpawn.id,
				afterRelocation.id,
			]);
			agent.respondToLlmRequest(
				afterWait.id,
				fauxAssistantMessage(
					fauxToolCall("read", { path: "relocated-marker.txt" }, { id: "read-relocated-marker" }),
				),
			);
			const readResult = await readToolResult(agent, "read-relocated-marker");
			expect(readTextContent(readResult.content)).toContain("mixed batch uses relocated runtime");

			const settled = await waitForNextMainRequest(agent, [
				spawnRequest.id,
				mainAfterSpawn.id,
				afterRelocation.id,
				afterWait.id,
			]);
			agent.respondToLlmRequest(settled.id, completedAssistantMessage("Relocation batch verified"));
		});
	});
});
