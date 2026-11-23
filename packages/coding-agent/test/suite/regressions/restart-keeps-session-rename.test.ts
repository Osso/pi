import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import type { RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { withHeadlessPi } from "../headless-pi.ts";

function sessionNameFrom(response: RpcResponse): string | undefined {
	if (response.type !== "response" || response.command !== "get_state" || !response.success) {
		throw new Error(`Unexpected get_state response: ${JSON.stringify(response)}`);
	}
	return response.data.sessionName;
}

it("keeps a manual rename when restart_self reapplies the original --name argument", async () => {
	await withHeadlessPi(
		async (pi) => {
			expect(sessionNameFrom(await pi.send({ type: "get_state" }))).toBe("Initial");
			await pi.send({ type: "set_session_name", name: "Revised" });

			await pi.send({ type: "prompt", message: "Restart Pi" });
			const beforeRestart = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				beforeRestart.id,
				fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
			);
			const afterRestart = await pi.waitForLlmRequest((request) => request.agentId === null);
			expect(afterRestart.sessionId).toBe(pi.sessionId);

			expect(sessionNameFrom(await pi.send({ type: "get_state" }))).toBe("Revised");
			pi.respondToLlmRequest(
				afterRestart.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Restarted" }), { stopReason: "toolUse" }),
			);
		},
		{ extraArgs: ["--name", "Initial"], noSessionName: true },
	);
}, 30_000);
