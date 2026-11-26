import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { RpcSessionSummary } from "../../src/modes/rpc/rpc-types.ts";
import { withHeadlessPi } from "./headless-pi.ts";

describe("list_sessions over RPC", () => {
	it("lists the persisted sessions of this project, and of all projects", async () => {
		await withHeadlessPi(async (agent) => {
			const first = await agent.send({ type: "get_state" });
			const firstPath = (first as { data: { sessionFile: string } }).data.sessionFile;
			await agent.send({ type: "prompt", message: "remember the first session" });
			const request = await agent.waitForLlmRequest((candidate) => candidate.agentId === null);
			agent.respondToLlmRequest(
				request.id,
				fauxAssistantMessage([{ type: "text", text: "Noted." }, fauxToolCall("end_turn", { reason: "Noted" })], {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "agent_settled");
			await agent.send({ type: "set_session_name", name: "first session" });
			expect(await agent.send({ type: "new_session" })).toMatchObject({ success: true });
			const current = await agent.send({ type: "get_state" });
			const currentPath = (current as { data: { sessionFile: string } }).data.sessionFile;
			expect(currentPath).not.toBe(firstPath);

			for (const scope of ["cwd", "all"] as const) {
				const listed = await agent.send({ type: "list_sessions", scope });
				expect(listed).toMatchObject({ success: true, command: "list_sessions" });
				const sessions = (listed as { data: { sessions: RpcSessionSummary[] } }).data.sessions;
				const first = sessions.find((session) => session.path === firstPath);
				expect(first, JSON.stringify(sessions.map((s) => s.path))).toMatchObject({
					name: "first session",
					firstMessage: "remember the first session",
				});
				expect(Number.isNaN(Date.parse(first?.modified ?? ""))).toBe(false);
			}
		});
	}, 60_000);
});
