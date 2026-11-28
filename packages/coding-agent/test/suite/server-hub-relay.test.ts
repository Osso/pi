import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import {
	enqueueStoredRuntimeMailboxMessage,
	getControlDbPath,
	listSharedChannelMessagesAfter,
	postSharedChannelMessage,
} from "../../src/core/session-control-db.ts";
import { withHeadlessPi } from "./headless-pi.ts";
import { type Frame, localHubCommand, startDaemon, stopDaemon } from "./server-daemon-fixture.ts";

async function waitForSpoke(hub: { request(type: string, fields?: Frame): Promise<Frame> }): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const machines = ((await hub.request("list_machines")).data as { machines: Frame[] }).machines;
		if (machines.some((machine) => machine.hostId === "spoke-id" && machine.status === "online")) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for spoke server");
}

it("carries a cross-host message to a running session and a channel post over the pi server hub link", async () => {
	await withHeadlessPi(async (hubAgent) => {
		await withHeadlessPi(async (spokeAgent) => {
			const hub = await startDaemon(hubAgent, null, { hostId: "hub-id", hub: "hub-id" });
			const spoke = await startDaemon(spokeAgent, null, {
				hostId: "spoke-id",
				hub: "hub-id",
				hubCommand: localHubCommand(hub.runtimeDir),
			});
			try {
				await waitForSpoke(hub.client);
				const spokeDb = getControlDbPath(spokeAgent.paths.agentDir);
				const hubDb = getControlDbPath(hubAgent.paths.agentDir);
				// What send_agent_message with toHost queues on the spoke.
				enqueueStoredRuntimeMailboxMessage(spokeDb, {
					kind: "message",
					recipientHost: "hub-id",
					recipient: { sessionId: hubAgent.sessionId, agentId: null },
					sender: { sessionId: spokeAgent.sessionId, agentId: null },
					storeRef: { sessionPath: "/spoke/session.jsonl", messageId: "hello-hub" },
					message: {
						id: "hello-hub",
						kind: "message",
						status: "pending",
						fromAgentId: "main",
						toAgentId: "main",
						body: "hello from the spoke",
						createdAt: new Date().toISOString(),
					},
				});
				// The hub's running session gets it as its next turn, naming the spoke as the host to reply to.
				const request = await hubAgent.waitForLlmRequest((candidate) =>
					JSON.stringify(candidate.messages).includes("hello from the spoke"),
				);
				expect(JSON.stringify(request.messages)).toContain("host: spoke-id (reply with toHost and toSessionId)");
				hubAgent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage([{ type: "text", text: "Got it." }, fauxToolCall("end_turn", { reason: "ok" })], {
						stopReason: "toolUse",
					}),
				);

				postSharedChannelMessage(spokeDb, {
					sender: { sessionId: spokeAgent.sessionId, agentId: null },
					body: "Restart /tmp/shared",
				});
				await expect
					.poll(() => listSharedChannelMessagesAfter(hubDb, 0), { timeout: 15_000 })
					.toMatchObject([{ originHost: "spoke-id", body: "Restart /tmp/shared" }]);
			} finally {
				await stopDaemon(spoke.daemon, spoke.runtimeDir);
				await stopDaemon(hub.daemon, hub.runtimeDir);
			}
		});
	});
}, 120_000);
