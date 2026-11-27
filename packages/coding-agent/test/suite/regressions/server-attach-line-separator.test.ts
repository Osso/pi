import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";
import { type Frame, ServerClient, startDaemon, stopDaemon } from "../server-daemon-fixture.ts";

// JSON leaves U+2028/U+2029 unescaped inside strings. pi server read worker stdout with node:readline, which
// also ends a line there, so the worker's get_messages response arrived as unparsable fragments and every
// attach_session failed with "RPC worker did not answer within 30 seconds" while the worker kept running.
describe("pi server attach to a session whose messages contain U+2028", () => {
	it("returns the snapshot and keeps streaming events", async () => {
		await withHeadlessPi(async (agent) => {
			const { daemon, client, runtimeDir } = await startDaemon(agent, null);
			try {
				const started = await client.request("start_session", { cwd: agent.paths.workspaceDir });
				if (started.success !== true) throw new Error(JSON.stringify(started));
				const { session } = started.data as { session: Frame };
				const sessionId = session.sessionId as string;
				const runtimeInstanceId = session.runtimeInstanceId as string;
				expect((await client.request("attach_session", { sessionId, mode: "control" })).success).toBe(true);
				// About 8 MB of tool output pasted into the prompt, with separators throughout.
				const prompt = `Summarize this log:\n${"build step ok\u2028".repeat(600_000)}end of log`;
				await client.request("session_rpc", {
					sessionId,
					runtimeInstanceId,
					command: { type: "prompt", message: prompt },
				});
				const request = await agent.waitForLlmRequest((item) => item.userMessages.includes(prompt));
				const reply = "Every step passed.\u2028\u2029No failures.";
				agent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage([{ type: "text", text: reply }, fauxToolCall("end_turn", { reason: "done" })], {
						stopReason: "toolUse",
					}),
				);
				// get_state carries no message text, so it reports the finished run even where text frames were lost.
				await expect
					.poll(
						async () => {
							const state = await client.request("session_rpc", {
								sessionId,
								runtimeInstanceId,
								command: { type: "get_state" },
							});
							return ((state.data as Frame).response as { data: Frame }).data;
						},
						{ timeout: 30_000, interval: 100 },
					)
					// Prompt, hidden set_session_name reminder (the session is unnamed), reply, end_turn result.
					.toMatchObject({ isStreaming: false, messageCount: 4 });

				const observer = await ServerClient.connect(join(runtimeDir, "pi", "server.sock"));
				try {
					const attached = await observer.request("attach_session", { sessionId, mode: "observe" });
					expect(attached).toMatchObject({ success: true, data: { mode: "observe" } });
					const snapshot = (attached.data as { snapshot: { get_messages: { messages: Frame[] } } }).snapshot;
					const texts = JSON.stringify(snapshot.get_messages.messages);
					expect(texts).toContain(JSON.stringify(prompt).slice(1, -1));
					expect(texts).toContain(JSON.stringify(reply).slice(1, -1));
				} finally {
					observer.close();
				}
				// Events carrying a separator reach clients too.
				const replyEnd = await client.waitForEvent((event) => {
					const sessionEvent = event.event as Frame | undefined;
					return sessionEvent?.type === "message_end" && JSON.stringify(sessionEvent.message).includes(reply);
				});
				expect(replyEnd).toMatchObject({ type: "session_event", sessionId });
			} finally {
				client.close();
				await stopDaemon(daemon, runtimeDir);
			}
		});
	}, 120_000);
});
