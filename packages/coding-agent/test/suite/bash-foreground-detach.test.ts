import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessLlmRequest, withHeadlessPi } from "./headless-pi.ts";

function expectSingleToolResult(request: HeadlessLlmRequest, expectedOutput: string): void {
	expect(request.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	expect(JSON.stringify(request.messages)).toContain(expectedOutput);
}

describe("headless Bash foreground and detach behavior", () => {
	it("keeps a fast Bash tool foreground without creating a background job", async () => {
		await withHeadlessPi(async (agent) => {
			await agent.send({ type: "prompt", message: "Run a fast foreground command" });
			const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf foreground-inline" }), {
					stopReason: "toolUse",
				}),
			);

			const afterTool = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialRequest.id,
			);
			expectSingleToolResult(afterTool, "foreground-inline");
			expect(agent.listAgents().filter((candidate) => candidate.displayName === "Bash command")).toHaveLength(0);
			await agent.send({ type: "abort" });
		});
	});

	it("creates a tracked Bash job only after auto-detach", async () => {
		await withHeadlessPi(
			async (agent) => {
				await agent.send({ type: "prompt", message: "Run a command that outlives the foreground threshold" });
				const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
				agent.respondToLlmRequest(
					initialRequest.id,
					fauxAssistantMessage(
						fauxToolCall("bash", { command: "printf before-detach; sleep 0.2; printf after-detach" }),
						{ stopReason: "toolUse" },
					),
				);

				const afterTool = await agent.waitForLlmRequest(
					(request) => request.agentId === null && request.id !== initialRequest.id,
				);
				expectSingleToolResult(afterTool, "Command moved to background as job");
				const detachedJob = await agent.waitForAgent(
					(candidate) => candidate.displayName === "Bash command" && candidate.lifecycle === "running",
				);
				await agent.waitForAgent((candidate) => candidate.id === detachedJob.id && candidate.lifecycle === "completed");
				await agent.send({ type: "abort" });
			},
			{ autoDetachTools: true },
		);
	});
});
