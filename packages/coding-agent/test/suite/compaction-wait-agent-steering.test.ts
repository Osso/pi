import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { getControlDbPath, postSharedChannelMessage } from "../../src/core/session-control-db.ts";
import { requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

it("accepts steering during a post-compaction wait with a live child restored across restart", async () => {
	await withHeadlessPi(async (agent) => {
		const mainSessionId = agent.sessionId;
		await agent.send({ type: "set_session_name", name: "Compaction steering regression" });
		await agent.send({ type: "prompt", message: "Record the completed table audit before delegation" });
		const audit = await agent.waitForLlmRequest((request) => request.sessionId === mainSessionId);
		agent.respondToLlmRequest(
			audit.id,
			fauxAssistantMessage(
				[
					{ type: "text", text: "Earlier table audit finished; retain the parallel worker assignment next." },
					fauxToolCall("end_turn", { reason: "Earlier audit complete" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		await agent.waitForEvent((event) => event.type === "agent_end");
		await agent.send({ type: "prompt", message: "Delegate the parallel worker and keep it running" });
		const initial = await agent.waitForLlmRequest((request) => request.sessionId === mainSessionId);
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "fresh",
					displayName: "Compaction parallel worker",
					prompt: "Keep investigating the other tables until released",
				}),
				{ stopReason: "toolUse" },
			),
		);
		const child = await agent.waitForAgent((candidate) => candidate.displayName === "Compaction parallel worker");
		const childSessionId = requireHeadlessAgentSessionId(child);
		await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		await agent.waitForLlmRequest((request) => request.sessionId === mainSessionId);

		const settingsPath = join(agent.paths.agentDir, "settings.json");
		const settings: Record<string, unknown> = JSON.parse(readFileSync(settingsPath, "utf8"));
		writeFileSync(
			settingsPath,
			JSON.stringify({
				...settings,
				compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 16384 },
			}),
		);
		writeFileSync(
			join(agent.paths.agentDir, "extensions", "manual-compaction-fixture.ts"),
			`
export default function (pi) {
	pi.on("compaction", async (event) => ({
		compaction: {
			summary: "Parallel worker remains active; resume waiting without discarding user steering.",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: {},
		},
	}));
}
`,
		);
		await agent.crash();
		await agent.restart();
		const restoredChildRequest = await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
		const beforeCompactionRequest = await agent.waitForLlmRequest((request) => request.sessionId === mainSessionId);
		expect(restoredChildRequest.userMessages).toContain("Keep investigating the other tables until released");
		expect(agent.listAgents().find((candidate) => candidate.id === child.id)?.transcript).toEqual(child.transcript);

		expect(await agent.send({ type: "get_state" })).toMatchObject({
			data: { isStreaming: true, isCompacting: false },
		});
		const compaction = agent.send({ type: "compact" });
		try {
			await agent.waitForSessionEntry(null, (entry) => entry.type === "compaction");
			const resumed = await agent.waitForLlmRequest(
				(request) => request.sessionId === mainSessionId && request.id !== beforeCompactionRequest.id,
			);
			const waitCallId = "post-compaction-live-child-wait";
			agent.respondToLlmRequest(
				resumed.id,
				fauxAssistantMessage(
					{
						...fauxToolCall("wait_agent", {}),
						id: waitCallId,
					},
					{ stopReason: "toolUse" },
				),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start" && event.toolCallId === waitCallId);
			const waitingState = await agent.send({ type: "get_state" });
			expect(waitingState).toMatchObject({
				success: true,
				command: "get_state",
				data: { isStreaming: true, isCompacting: false },
			});

			const steering = "is that the only table needing updates? what happened to the other parallel workers?";
			await expect(
				agent.send({ type: "prompt", message: steering, streamingBehavior: "steer" }),
			).resolves.toMatchObject({ success: true, command: "prompt" });
			expect(await agent.send({ type: "get_state" })).toMatchObject({
				data: { isCompacting: false, pendingMessageCount: 1 },
			});
			// RPC has no terminal steering-wake subscription. Release the real wait through
			// its coordination channel, without completing or cancelling the live child.
			postSharedChannelMessage(getControlDbPath(agent.paths.agentDir), {
				body: "Process the accepted user steering while the parallel worker stays active.",
				sender: { agentId: null, sessionId: "compaction-test-peer" },
			});
			await agent.waitForEvent((event) => event.type === "tool_execution_end" && event.toolCallId === waitCallId);
			const steered = await agent.waitForLlmRequest(
				(request) => request.sessionId === mainSessionId && request.userMessages.includes(steering),
			);
			expect(steered.userMessages.filter((text) => text === steering)).toHaveLength(1);
			expect(await agent.send({ type: "get_state" })).toMatchObject({ data: { pendingMessageCount: 0 } });
			expect(agent.listAgents().find((candidate) => candidate.id === child.id)).toMatchObject({
				lifecycle: "running",
				transcript: child.transcript,
			});
			expect(
				agent
					.readSessionEntries(null)
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(steering),
					),
			).toHaveLength(1);
			agent.respondToLlmRequest(
				steered.id,
				fauxAssistantMessage(
					fauxToolCall("end_turn", {
						reason: "Steering delivered without terminating the parallel worker",
					}),
					{ stopReason: "toolUse" },
				),
			);
			await expect(compaction).resolves.toMatchObject({ success: true, command: "compact" });
		} finally {
			await agent.send({ type: "abort" });
			await compaction;
		}
	});
}, 60_000);
