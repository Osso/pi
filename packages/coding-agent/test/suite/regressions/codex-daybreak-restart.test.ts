import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const CODEX_FIXTURE = { model: "headless-faux-codex", provider: "openai-codex" } as const;
// The faux Codex model is not Blue-eligible, so the selection is persisted but reported inactive.
const INACTIVE_STATUS = "daybreak blue inactive";

async function spawnLiveChild(agent: HeadlessPi): Promise<void> {
	await agent.send({ type: "prompt", message: "Spawn a child before selecting Daybreak" });
	const initialMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		initialMainRequest.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", {
				context: "fresh",
				displayName: "Live Daybreak child",
				prompt: "Remain live across the supervisor restart",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent(
		(candidate) => candidate.displayName === "Live Daybreak child" && candidate.lifecycle === "running",
	);
	await agent.waitForLlmRequest((request) => request.agentId === child.id);
	const mainAfterSpawn = await agent.waitForLlmRequest(
		(request) => request.agentId === null && request.id !== initialMainRequest.id,
	);
	agent.respondToLlmRequest(
		mainAfterSpawn.id,
		fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Child remains live" }), { stopReason: "toolUse" }),
	);
	await agent.waitForEvent((event) => event.type === "agent_end");
}

it("preserves the Daybreak Blue selection across /restart while a child is live", async () => {
	await withHeadlessPi(async (agent) => {
		await spawnLiveChild(agent);
		const sessionId = agent.sessionId;

		await agent.send({ type: "prompt", message: "/daybreak blue" });
		const selectedStatus = await agent.waitForExtensionUiRequest(
			(request) =>
				request.method === "setStatus" &&
				request.statusKey === "codex-daybreak" &&
				request.statusText === INACTIVE_STATUS,
		);
		expect(agent.readSessionEntries(null)).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "codex-daybreak", data: { cyber: "daybreak_blue" } }),
		);

		void agent.send({ type: "prompt", message: "/restart" }).catch(() => {
			// Process replacement can close the pending RPC command before it returns a response.
		});

		expect(agent.sessionId).toBe(sessionId);
		const restoredStatus = await agent.waitForExtensionUiRequest(
			(request) =>
				request.id !== selectedStatus.id &&
				request.method === "setStatus" &&
				request.statusKey === "codex-daybreak" &&
				request.statusText === INACTIVE_STATUS,
		);
		expect(restoredStatus).toMatchObject({ statusKey: "codex-daybreak", statusText: INACTIVE_STATUS });
	}, CODEX_FIXTURE);
}, 30_000);
