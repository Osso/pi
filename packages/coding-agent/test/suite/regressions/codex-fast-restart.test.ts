import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { writeFileSync } from "fs";
import { join } from "path";
import { expect, it } from "vitest";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const CODEX_FIXTURE = { model: "headless-faux-codex", provider: "openai-codex" } as const;

async function spawnLiveChild(agent: HeadlessPi): Promise<void> {
	await agent.send({ type: "prompt", message: "Spawn a child before enabling fast mode" });
	const initialMainRequest = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		initialMainRequest.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", {
				context: "fresh",
				displayName: "Live fast-mode child",
				prompt: "Remain live across the supervisor restart",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent(
		(candidate) => candidate.displayName === "Live fast-mode child" && candidate.lifecycle === "running",
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

async function enableFastUltra(agent: HeadlessPi): Promise<string> {
	await agent.send({ type: "prompt", message: "/fast ultra" });
	const status = await agent.waitForExtensionUiRequest(
		(request) =>
			request.method === "setStatus" && request.statusKey === "codex-fast" && request.statusText === "fast ultra",
	);
	expect(status).toMatchObject({ statusKey: "codex-fast", statusText: "fast ultra" });
	return status.id;
}

async function expectFastUltraAfterRestart(
	agent: HeadlessPi,
	sessionId: string,
	enabledStatusId: string,
): Promise<void> {
	void agent.send({ type: "prompt", message: "/restart" }).catch(() => {
		// Process replacement can close the pending RPC command before it returns a response.
	});

	expect(agent.sessionId).toBe(sessionId);
	const restoredStatus = await agent.waitForExtensionUiRequest(
		(request) =>
			request.id !== enabledStatusId &&
			request.method === "setStatus" &&
			request.statusKey === "codex-fast" &&
			request.statusText === "fast ultra",
	);
	expect(restoredStatus).toMatchObject({ statusKey: "codex-fast", statusText: "fast ultra" });
}

it("preserves Codex fast mode across /restart before the first assistant response", async () => {
	await withHeadlessPi(async (agent) => {
		const sessionId = agent.sessionId;
		const enabledStatusId = await enableFastUltra(agent);

		await expectFastUltraAfterRestart(agent, sessionId, enabledStatusId);
	}, CODEX_FIXTURE);
}, 30_000);

it("preserves Codex fast mode across /restart while a child is live", async () => {
	await withHeadlessPi(async (agent) => {
		await spawnLiveChild(agent);
		const sessionId = agent.sessionId;
		const enabledStatusId = await enableFastUltra(agent);
		expect(agent.readSessionEntries(null)).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: "codex-fast-mode",
				data: { serviceTier: "ultrafast" },
			}),
		);

		await expectFastUltraAfterRestart(agent, sessionId, enabledStatusId);
	}, CODEX_FIXTURE);
}, 30_000);

it("uses the configured fast default after /restart while a child is live", async () => {
	await withHeadlessPi(async (agent) => {
		await spawnLiveChild(agent);
		const sessionId = agent.sessionId;
		writeFileSync(
			join(agent.paths.agentDir, "settings.json"),
			JSON.stringify({ defaultCodexFastMode: "priority" }, null, 2),
		);

		void agent.send({ type: "prompt", message: "/restart" }).catch(() => {
			// Process replacement can close the pending RPC command before it returns a response.
		});

		expect(agent.sessionId).toBe(sessionId);
		const configuredStatus = await agent.waitForExtensionUiRequest(
			(request) =>
				request.method === "setStatus" && request.statusKey === "codex-fast" && request.statusText === "fast",
		);
		expect(configuredStatus).toMatchObject({ statusKey: "codex-fast", statusText: "fast" });
		expect(agent.readSessionEntries(null)).not.toContainEqual(
			expect.objectContaining({ type: "custom", customType: "codex-fast-mode" }),
		);
	}, CODEX_FIXTURE);
}, 30_000);
