import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";

// Every session waits at startup until the release file exists. It exists while the main session starts and
// is removed before the spawn, so the child session is held mid-construction until the test releases it.
const release = join(process.env.TMPDIR ?? "/tmp", `spawn-construction-release-${process.pid}`);

it("fails a spawn aborted while its child is built and never starts the child, also after a restart", async () => {
	writeFileSync(release, "release");
	await withHeadlessPi(
		async (pi) => {
			rmSync(release);
			rmSync(`${release}.ready`, { force: true });
			let childModelRequests = 0;
			void pi
				.waitForLlmRequest((request) => request.agentId !== null)
				.then(() => {
					childModelRequests += 1;
				})
				.catch(() => undefined);

			await pi.send({ type: "prompt", message: "Spawn a worker" });
			const spawnRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				spawnRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Held worker",
						prompt: "write the report",
					}),
					{ stopReason: "toolUse" },
				),
			);
			await vi.waitFor(() => expect(existsSync(`${release}.ready`)).toBe(true), { timeout: 20_000 });

			await pi.send({ type: "abort" });
			writeFileSync(release, "release");
			// The spawn settles once construction returns: the row commits as failed, never as running.
			await vi.waitFor(
				() =>
					expect(pi.listAgents().find((candidate) => candidate.displayName === "Held worker")).toMatchObject({
						lifecycle: "failed",
						revision: 1,
					}),
				{ timeout: 10_000 },
			);
			const agent = pi.listAgents().find((candidate) => candidate.displayName === "Held worker");

			await pi.send({ type: "prompt", message: "Restart Pi" });
			const beforeRestart = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== spawnRequest.id,
			);
			pi.respondToLlmRequest(
				beforeRestart.id,
				fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
			);
			const afterRestart = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== beforeRestart.id,
			);
			pi.respondToLlmRequest(
				afterRestart.id,
				fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Restarted" }), { stopReason: "toolUse" }),
			);
			await pi.waitForEvent((event) => event.type === "agent_end");

			expect(pi.listAgents().find((candidate) => candidate.id === agent?.id)).toMatchObject({
				lifecycle: "failed",
				revision: 1,
			});
			expect(childModelRequests).toBe(0);
		},
		{ env: { PI_HEADLESS_SESSION_START_RELEASE_PATH: release } },
	);
	rmSync(release, { force: true });
	rmSync(`${release}.ready`, { force: true });
}, 90_000);
