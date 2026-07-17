import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readRuntimeMailboxListener } from "../../../src/core/session-control-db.ts";
import { withHeadlessPi } from "../headless-pi.ts";

describe("sub-agent completion report ordering", () => {
	it("includes a terminal child report in the parent model call after list_agents", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Spawn a short-lived tracing child" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						displayName: "Short-lived tracing child",
						prompt: "Return the exact text: trace complete",
					}),
					{ stopReason: "toolUse" },
				),
			);

			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Short-lived tracing child");
			const childSessionId = spawned.transcript?.sessionId;
			if (!childSessionId) throw new Error("Short-lived tracing child has no child session ID");
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const recipient = { agentId: spawned.id, sessionId: childSessionId };
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("running");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeDefined();

			const childRequest = await pi.waitForLlmRequest((request) => request.agentId === spawned.id);
			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainRequest.id,
			);
			pi.respondToLlmRequest(childRequest.id, fauxAssistantMessage("trace complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" }),
			);
			const listResult = await pi.waitForSessionEntry(
				null,
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "list_agents",
			);
			expect(JSON.stringify(listResult)).toContain("Found 0 agents");
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)?.lifecycle).toBe("completed");
			expect(readRuntimeMailboxListener(controlDbPath, recipient)).toBeUndefined();
			expect(pi.listMailboxMessages().filter((message) => message.fromAgentId === spawned.id)).toMatchObject([
				{ status: "delivered" },
			]);
			expect(
				pi.listRuntimeMailboxMessages().filter((message) => message.sender.agentId === spawned.id),
			).toMatchObject([{ status: "delivered" }]);

			const nextParentRequest = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== mainAfterSpawn.id,
			);
			expect(nextParentRequest.userMessages).toContainEqual(expect.stringContaining("trace complete"));
		});
	});
});
