import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";
import { type Frame, type ServerClient, startDaemon, stopDaemon } from "./server-daemon-fixture.ts";

function completed(text: string) {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

async function listedSession(client: ServerClient, sessionId: string): Promise<Frame | undefined> {
	const response = await client.request("list_sessions", { includeEnded: true });
	if (response.success !== true) throw new Error(JSON.stringify(response.error));
	return (response.data as { sessions: Frame[] }).sessions.find((session) => session.sessionId === sessionId);
}

/** The first pushed summary of the session after `afterRevision` that matches. */
function waitForSessionUpdate(
	client: ServerClient,
	sessionId: string,
	afterRevision: number,
	predicate: (session: Frame) => boolean,
): Promise<Frame> {
	return client.waitForEvent((event) => {
		const session = event.session as Frame | undefined;
		return (
			event.type === "session_updated" &&
			(event.revision as number) > afterRevision &&
			session?.sessionId === sessionId &&
			predicate(session)
		);
	});
}

const agentsOf = (session: Frame) => session.agents as Frame[] | undefined;

describe("pi server session agents", () => {
	it("lists and pushes a running session's active sub-agents, and drops them when they finish", async () => {
		await withHeadlessPi(async (agent) => {
			const { daemon, client, runtimeDir } = await startDaemon(agent, null);
			try {
				const started = await client.request("start_session", { cwd: agent.paths.workspaceDir });
				if (started.success !== true) throw new Error(JSON.stringify(started));
				const { session } = started.data as { session: Frame };
				const sessionId = session.sessionId as string;
				expect(agentsOf((await listedSession(client, sessionId)) ?? {})).toBeUndefined();
				expect((await client.request("attach_session", { sessionId, mode: "control" })).success).toBe(true);
				await client.request("session_rpc", {
					sessionId,
					runtimeInstanceId: session.runtimeInstanceId,
					command: { type: "prompt", message: "Spawn a helper." },
				});
				const mainRequest = await agent.waitForLlmRequest(
					(request) => request.sessionId === sessionId && request.userMessages.includes("Spawn a helper."),
				);
				agent.respondToLlmRequest(
					mainRequest.id,
					fauxAssistantMessage(
						fauxToolCall("spawn_agent", { context: "fresh", displayName: "helper", prompt: "Run the sleeper." }),
						{ stopReason: "toolUse" },
					),
				);
				const childRequest = await agent.waitForLlmRequest(
					(request) =>
						request.sessionId !== sessionId &&
						request.sessionId !== agent.sessionId &&
						JSON.stringify(request.messages).includes("Run the sleeper."),
				);
				const mainAfterSpawn = await agent.waitForLlmRequest(
					(request) => request.sessionId === sessionId && request.id !== mainRequest.id,
				);
				agent.respondToLlmRequest(mainAfterSpawn.id, completed("Spawned."));

				const thinking = {
					id: expect.stringMatching(/^agent_/),
					parentId: "main",
					displayName: "helper",
					agentType: "default",
					lifecycle: "running",
					activity: "thinking",
					model: "headless-faux/headless-faux-1",
				};
				expect(agentsOf((await listedSession(client, sessionId)) ?? {})).toEqual([thinking]);
				const pushed = await waitForSessionUpdate(client, sessionId, 0, (summary) =>
					Boolean(agentsOf(summary)?.some((child) => child.displayName === "helper")),
				);
				expect(agentsOf(pushed.session as Frame)).toEqual([expect.objectContaining({ lifecycle: "running" })]);

				agent.respondToLlmRequest(
					childRequest.id,
					fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 4" }), { stopReason: "toolUse" }),
				);
				const acting = await waitForSessionUpdate(
					client,
					sessionId,
					pushed.revision as number,
					(summary) => agentsOf(summary)?.[0]?.activity === "bash: sleep 4",
				);
				expect(agentsOf(acting.session as Frame)).toEqual([{ ...thinking, activity: "bash: sleep 4" }]);

				const childAfterTool = await agent.waitForLlmRequest(
					(request) => request.sessionId === childRequest.sessionId && request.id !== childRequest.id,
				);
				agent.respondToLlmRequest(childAfterTool.id, completed("Slept."));
				const finished = await waitForSessionUpdate(
					client,
					sessionId,
					acting.revision as number,
					(summary) => !("agents" in summary),
				);
				expect(finished.session).toMatchObject({ sessionId, status: expect.stringMatching(/^(running|idle)$/) });
				expect(await listedSession(client, sessionId)).not.toHaveProperty("agents");
			} finally {
				client.close();
				await stopDaemon(daemon, runtimeDir);
			}
		});
	}, 90_000);
});
