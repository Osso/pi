import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";
import { type Frame, localHubCommand, type ServerClient, startDaemon, stopDaemon } from "./server-daemon-fixture.ts";

function endTurn(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

async function pollSpokeSession(client: ServerClient, sessionId: string, status: string): Promise<Frame> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const response = await client.request("list_sessions", { hostId: "spoke-id", includeEnded: true });
		const sessions = (response.data as { sessions?: Frame[] } | undefined)?.sessions ?? [];
		const session = sessions.find((entry) => entry.sessionId === sessionId && entry.status === status);
		if (session) return session;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for spoke session ${sessionId} to be ${status}`);
}

function countUserMessages(sessionPath: string): number {
	return readFileSync(sessionPath, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } })
		.filter((entry) => entry.type === "message" && entry.message?.role === "user").length;
}

it("runs a spawn_agent child on another host through the hub and routes its result across a parent restart", async () => {
	await withHeadlessPi(async (hubAgent) => {
		await withHeadlessPi(async (spokeAgent) => {
			const hub = await startDaemon(hubAgent, null, { hostId: "hub-id", hub: "hub-id" });
			const spoke = await startDaemon(spokeAgent, null, {
				hostId: "spoke-id",
				hub: "hub-id",
				hubCommand: localHubCommand(hub.runtimeDir),
			});
			try {
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline) {
					const machines = ((await hub.client.request("list_machines")).data as { machines: Frame[] }).machines;
					if (machines.some((machine) => machine.hostId === "spoke-id" && machine.status === "online")) break;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				// The parent runs on the hub machine: same host ID and server socket as the hub daemon.
				await withHeadlessPi(
					async (parent) => {
						const assignment = "Count the files in the spoke workspace.";
						expect(await parent.send({ type: "prompt", message: "Spawn a child on the spoke" })).toMatchObject({
							success: true,
						});
						const initial = await parent.waitForLlmRequest((request) => request.agentId === null);
						parent.respondToLlmRequest(
							initial.id,
							fauxAssistantMessage(
								fauxToolCall("spawn_agent", {
									host: "spoke-id",
									cwd: spokeAgent.paths.workspaceDir,
									displayName: "remote-child",
									prompt: assignment,
								}),
								{ stopReason: "toolUse" },
							),
						);
						const afterDispatch = await parent.waitForLlmRequest(
							(request) => request.agentId === null && request.id !== initial.id,
						);
						expect(JSON.stringify(afterDispatch.messages)).toContain("context: fresh, host: spoke-id");
						const child = await parent.waitForAgent(
							(candidate) => candidate.displayName === "remote-child" && candidate.lifecycle === "running",
						);
						const remoteSessionId = child.transcript?.sessionId ?? "";
						expect(child.transcript).toEqual({ host: "spoke-id", sessionId: remoteSessionId });
						expect(child.cwd).toBe(spokeAgent.paths.workspaceDir);
						const childRequest = await spokeAgent.waitForLlmRequest(
							(request) => request.sessionId === remoteSessionId,
						);
						const childPrompt = childRequest.userMessages.join("\n");
						expect(childPrompt).toContain(assignment);
						expect(childPrompt).toContain(`toSessionId "${parent.sessionId}", toHost "hub-id"`);

						// Restart the parent while the remote child's model request is outstanding.
						void parent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
						const restoredMain = await parent.waitForLlmRequest(
							(request) =>
								request.agentId === null &&
								JSON.stringify(request.messages).includes("The agent process was restarted"),
						);
						expect(parent.listAgents().find((candidate) => candidate.id === child.id)).toMatchObject({
							lifecycle: "running",
							transcript: child.transcript,
						});
						parent.respondToLlmRequest(restoredMain.id, endTurn("Parent recovered"));
						await parent.waitForEvent((event) => event.type === "agent_end");

						const completion = "The spoke workspace has 3 files.";
						spokeAgent.respondToLlmRequest(childRequest.id, endTurn(completion));
						const completed = await parent.waitForAgent(
							(candidate) => candidate.id === child.id && candidate.lifecycle === "completed",
						);
						expect(completed.result?.summary).toBe(completion);
						expect(completed.transcript).toEqual(child.transcript);
						const notification = await parent.waitForLlmRequest(
							(request) =>
								request.agentId === null && request.userMessages.some((text) => text.includes(completion)),
						);
						expect(notification.userMessages.filter((text) => text.includes(completion))).toHaveLength(1);
						parent.respondToLlmRequest(notification.id, endTurn("Completion received once"));

						// The finished child's worker is stopped, and the reattach did not prompt it again.
						const ended = await pollSpokeSession(hub.client, remoteSessionId, "ended");
						expect(countUserMessages(String(ended.sessionPath))).toBe(1);
					},
					{
						env: { PI_SERVER_HOST_ID: "hub-id", XDG_RUNTIME_DIR: hub.runtimeDir },
						settings: { server: { hub: "hub-id" } },
					},
				);
			} finally {
				hub.client.close();
				spoke.client.close();
				await stopDaemon(spoke.daemon, spoke.runtimeDir);
				await stopDaemon(hub.daemon, hub.runtimeDir);
			}
		});
	});
}, 180_000);
