import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

function completedResponse(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

// Contract: pingdotgg/t3code 32ecd71726fee16f335484c1f95cbce126d461f6,
// packages/provider-pi/src/server/{adapter,status}.ts. These tests run Pi's real
// RPC process, not T3's adapter. agent_end alone must not complete a T3 turn.
describe("T3 Code native Pi RPC contract", () => {
	it("discovers models and commands, settles extension continuations, and restores native history", async () => {
		await withHeadlessPi(
			async (agent) => {
				const models = await agent.send({ type: "get_available_models" });
				expect(models).toMatchObject({
					success: true,
					data: { models: expect.arrayContaining([expect.objectContaining({ id: "headless-faux-1" })]) },
				});
				const commands = await agent.send({ type: "get_commands" });
				expect(commands).toMatchObject({
					success: true,
					data: { commands: expect.arrayContaining([expect.objectContaining({ name: "t3-status" })]) },
				});
				expect(await agent.send({ type: "prompt", message: "/t3-status" })).toMatchObject({ success: true });
				await agent.waitForExtensionUiRequest(
					(request) => request.method === "notify" && request.message === "T3 contract command completed",
				);
				expect(await agent.send({ type: "get_state" })).toMatchObject({
					success: true,
					data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
				});

				expect(await agent.send({ type: "prompt", message: "T3 native turn" })).toMatchObject({ success: true });
				const first = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(first.id, completedResponse("First response"));
				await agent.waitForEvent((event) => event.type === "agent_end");
				const settled = agent.waitForEvent((event) => event.type === "agent_settled");
				const nextRequest = agent.waitForLlmRequest();
				expect(
					await Promise.race([settled.then(() => "premature settlement"), nextRequest.then(() => "continuation")]),
				).toBe("continuation");
				const followUp = await nextRequest;
				expect(followUp.userMessages).toContain("T3 extension follow-up");
				expect(await agent.send({ type: "get_state" })).toMatchObject({ data: { isStreaming: true } });
				agent.respondToLlmRequest(followUp.id, completedResponse("Final response"));
				expect(await settled).toEqual({ type: "agent_settled", aborted: false });
				expect(await agent.send({ type: "get_state" })).toMatchObject({
					data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
				});
				const history = await agent.send({ type: "get_entries" });
				if (!history.success || history.command !== "get_entries") throw new Error("get_entries failed");
				expect(history.data.entries.filter((entry) => entry.type === "message")).toHaveLength(6);
				const leafId = history.data.leafId;
				if (!leafId) throw new Error("Completed T3 turn has no native leaf");
				expect(await agent.send({ type: "get_entries", since: leafId })).toMatchObject({
					data: { entries: [], leafId },
				});
				const originalSessionId = agent.sessionId;
				await agent.restart();
				expect(agent.sessionId).toBe(originalSessionId);
				expect(await agent.send({ type: "get_entries" })).toMatchObject({ data: history.data });
			},
			{ cliPath: join(import.meta.dirname, "fixtures", "t3-rpc-contract-cli.ts") },
		);
	}, 60_000);

	it("keeps a retrying turn active until recovery settles", async () => {
		await withHeadlessPi(
			async (agent) => {
				await agent.send({ type: "prompt", message: "Retry this T3 turn" });
				const first = await agent.waitForLlmRequest();
				agent.respondToLlmRequest(
					first.id,
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
				);
				await agent.waitForEvent((event) => event.type === "auto_retry_start");
				const settled = agent.waitForEvent((event) => event.type === "agent_settled");
				const retryRequest = agent.waitForLlmRequest();
				expect(
					await Promise.race([settled.then(() => "premature settlement"), retryRequest.then(() => "retry")]),
				).toBe("retry");
				const retry = await retryRequest;
				agent.respondToLlmRequest(retry.id, completedResponse("Recovered"));
				await agent.waitForEvent((event) => event.type === "auto_retry_end" && event.success);
				expect(await settled).toEqual({ type: "agent_settled", aborted: false });
				expect(await agent.send({ type: "get_state" })).toMatchObject({
					data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
				});
			},
			{ cliPath: join(import.meta.dirname, "fixtures", "t3-rpc-retry-cli.ts") },
		);
	}, 60_000);

	it("reports native abort and permits a new turn after settlement", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Abort this T3 turn" });
			await agent.waitForLlmRequest();
			expect(await agent.send({ type: "abort" })).toMatchObject({ success: true });
			expect(await agent.waitForEvent((event) => event.type === "agent_settled")).toEqual({
				type: "agent_settled",
				aborted: true,
			});
			await agent.send({ type: "prompt", message: "Next T3 turn" });
			const next = await agent.waitForLlmRequest();
			expect(next.userMessages).toContain("Next T3 turn");
			agent.respondToLlmRequest(next.id, completedResponse("Next turn completed"));
			expect(await agent.waitForEvent((event) => event.type === "agent_settled")).toEqual({
				type: "agent_settled",
				aborted: false,
			});
		});
	}, 60_000);
});
