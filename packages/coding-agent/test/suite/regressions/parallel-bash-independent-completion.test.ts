import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

it("reports a fast Bash call in a parallel batch without waiting for a slow sibling", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.send({ type: "prompt", message: "Run a slow and a fast command together" });
		const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
		const batchStartedAt = Date.now();
		agent.respondToLlmRequest(
			initialRequest.id,
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "sleep 4; printf slow-done" }, { id: "slow-call" }),
					fauxToolCall("bash", { command: "printf fast-done" }, { id: "fast-call" }),
				],
				{ stopReason: "toolUse" },
			),
		);

		const fastEnd = await agent.waitForEvent(
			(event) => event.type === "tool_execution_end" && event.toolCallId === "fast-call",
		);
		// The slow sibling sleeps 4 s; the fast call must not wait for it.
		expect(Date.now() - batchStartedAt).toBeLessThan(3_000);
		expect(JSON.stringify(fastEnd)).toContain("fast-done");
		await agent.waitForEvent((event) => event.type === "tool_execution_end" && event.toolCallId === "slow-call");

		const afterTools = await agent.waitForLlmRequest(
			(request) => request.agentId === null && request.id !== initialRequest.id,
		);
		const results = JSON.stringify(afterTools.messages.filter((message) => message.role === "toolResult"));
		expect(results).toContain("slow-done");
		expect(results).toContain("fast-done");
		await agent.send({ type: "abort" });
	});
}, 30_000);
