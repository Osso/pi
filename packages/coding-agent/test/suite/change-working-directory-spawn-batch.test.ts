import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, listSessionMetadata, readMultiAgentState } from "../../src/core/session-control-db.ts";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

function completedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

// Reads tool results from events: relocation moves the transcript away from the fixture's original session path.
async function readToolResultText(agent: HeadlessPi, toolCallId: string): Promise<string> {
	const event = await agent.waitForEvent(
		(candidate) => candidate.type === "tool_execution_end" && candidate.toolCallId === toolCallId,
	);
	if (event.type !== "tool_execution_end") throw new Error(`No ${toolCallId} result`);
	const content = (event.result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content.map((part) => part.text ?? "").join("\n");
}

describe("change_working_directory and spawn_agent in one tool batch", () => {
	it("keeps the spawned child visible to the relocated session", async () => {
		// The default per-cwd session directory makes relocation move the transcript to a new path, as in production.
		await withHeadlessPi(
			async (agent) => {
				const targetCwd = join(agent.paths.tempDir, "spawn-batch-target");
				mkdirSync(targetCwd);
				const isMainRequest = (sessionId: string | undefined) => sessionId === agent.sessionId;

				await agent.send({ type: "prompt", message: "Move to the project and start a child" });
				const batchRequest = await agent.waitForLlmRequest((request) => isMainRequest(request.sessionId));
				agent.respondToLlmRequest(
					batchRequest.id,
					fauxAssistantMessage(
						[
							{ ...fauxToolCall("change_working_directory", { path: targetCwd }), id: "cd-in-spawn-batch" },
							{
								...fauxToolCall("spawn_agent", {
									context: "fresh",
									displayName: "Spawn batch child",
									prompt: "Report done",
								}),
								id: "spawn-in-cd-batch",
							},
						],
						{ stopReason: "toolUse" },
					),
				);
				expect(await readToolResultText(agent, "spawn-in-cd-batch")).toContain("Spawned");

				const afterBatch = await agent.waitForLlmRequest(
					(request) => isMainRequest(request.sessionId) && request.id !== batchRequest.id,
				);
				agent.respondToLlmRequest(
					afterBatch.id,
					fauxAssistantMessage(
						{ ...fauxToolCall("list_agents", {}), id: "list-after-cd-batch" },
						{ stopReason: "toolUse" },
					),
				);
				expect(await readToolResultText(agent, "list-after-cd-batch")).toContain("Spawn batch child");

				const controlDbPath = getControlDbPath(agent.paths.agentDir);
				const relocated = listSessionMetadata(controlDbPath).find((row) => row.id === agent.sessionId);
				expect(relocated?.cwd).toBe(targetCwd);
				if (!relocated) throw new Error("Relocated main session metadata missing");
				expect(relocated.sessionPath).not.toBe(agent.sessionFile);
				expect(readMultiAgentState(controlDbPath, relocated.sessionPath)?.agents).toEqual([
					expect.objectContaining({ displayName: "Spawn batch child" }),
				]);
				expect(readMultiAgentState(controlDbPath, agent.sessionFile)).toBeUndefined();

				const settled = await agent.waitForLlmRequest(
					(request) =>
						isMainRequest(request.sessionId) && request.id !== batchRequest.id && request.id !== afterBatch.id,
				);
				agent.respondToLlmRequest(settled.id, completedAssistantMessage("Spawn batch verified"));
			},
			{ env: { PI_CODING_AGENT_SESSION_DIR: "" } },
		);
	});
});
