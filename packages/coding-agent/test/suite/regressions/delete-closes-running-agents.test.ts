import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { isProcessIdentityAlive, readProcessIdentity } from "../../../src/core/runtime-process.ts";
import {
	getControlDbPath,
	readRuntimeMailboxListener,
	readSessionMetadata,
} from "../../../src/core/session-control-db.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

it("/delete closes running child agents, then deletes the session and their transcripts", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Spawn a worker" });
		const main = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			main.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { context: "fresh", displayName: "Worker", prompt: "Work until closed" }),
				{ stopReason: "toolUse" },
			),
		);
		const child = await agent.waitForAgent((candidate) => candidate.displayName === "Worker");
		// The child's model request stays unanswered, so the child is mid-turn when /delete runs.
		await agent.waitForLlmRequest((request) => request.sessionId === requireHeadlessAgentSessionId(child));
		const mainAfterSpawn = await agent.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== main.id,
		);
		agent.respondToLlmRequest(
			mainAfterSpawn.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Spawned" }), { stopReason: "toolUse" }),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");
		const childTranscript = child.transcript?.path;
		if (!childTranscript) throw new Error("Worker has no transcript");
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const parentListener = readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: agent.sessionId });
		if (!parentListener) throw new Error("Expected parent runtime mailbox listener");
		const parentRuntimeIdentity = readProcessIdentity(parentListener.pid);
		expect([existsSync(agent.sessionFile), existsSync(childTranscript)]).toEqual([true, true]);

		const response = agent.send({ type: "prompt", message: "/delete" });
		const dialog = await agent.waitForExtensionUiRequest((request) => request.method === "confirm");
		expect(dialog).toMatchObject({
			message:
				"Close the 1 running child agent, delete the current session and its child agent sessions, then quit.",
		});
		await agent.respondToExtensionUiRequest({ type: "extension_ui_response", id: dialog.id, confirmed: true });
		expect((await response).success).toBe(true);

		await vi.waitFor(
			() => {
				expect(isProcessIdentityAlive(parentRuntimeIdentity)).toBe(false);
				expect([existsSync(agent.sessionFile), existsSync(childTranscript)]).toEqual([false, false]);
			},
			{ timeout: 15_000, interval: 50 },
		);
		expect(readSessionMetadata(controlDbPath, agent.sessionFile)).toBeUndefined();
		expect(readSessionMetadata(controlDbPath, childTranscript)).toBeUndefined();
	});
}, 90_000);
