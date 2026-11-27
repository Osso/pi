import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { type HeadlessLlmRequest, withHeadlessPi } from "./headless-pi.ts";

describe("RPC detach_running_tool", () => {
	it("detaches an active tool call and returns false when idle", async () => {
		await withHeadlessPi(async (agent) => {
			const idleResponse = await agent.send({ type: "detach_running_tool" });
			expect(idleResponse).toMatchObject({
				type: "response",
				command: "detach_running_tool",
				success: true,
				data: { detached: false },
			});

			await agent.send({ type: "prompt", message: "Run the long command" });
			const initialRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(
				initialRequest.id,
				fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30; printf detached-output" }), {
					stopReason: "toolUse",
				}),
			);
			await agent.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "bash");

			const detachResponse = await agent.send({ type: "detach_running_tool" });
			expect(detachResponse).toMatchObject({
				type: "response",
				command: "detach_running_tool",
				success: true,
				data: { detached: true },
			});

			const afterTool = await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialRequest.id,
			);
			expectSingleToolResult(afterTool, "Command moved to background as job");
			await agent.send({ type: "abort" });
		});
	});
});

function expectSingleToolResult(request: HeadlessLlmRequest, expectedOutput: string): void {
	expect(request.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	expect(JSON.stringify(request.messages)).toContain(expectedOutput);
}
