import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readMultiAgentRuntimeOwnership } from "../../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";
import { type HeadlessLlmRequest, withHeadlessPi } from "../headless-pi.ts";

const LARGE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RSS_GROWTH_KIB = 512 * 1024;

function readRssKiB(pid: number): number {
	const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m);
	if (!match) throw new Error(`Missing VmRSS for process ${pid}`);
	return Number(match[1]);
}

function readMainRuntimeInstanceId(controlDbPath: string, sessionId: string): string {
	const db = createSqliteDatabase(controlDbPath);
	try {
		const row = db
			.prepare(
				`SELECT runtime_instance_id FROM runtime_mailbox_listeners
				 WHERE recipient_session_id = ? AND recipient_agent_id_key = ''`,
			)
			.get(sessionId) as { runtime_instance_id: string } | undefined;
		if (!row) throw new Error(`Missing main runtime listener for session ${sessionId}`);
		return row.runtime_instance_id;
	} finally {
		db.close();
	}
}

describe("post-restart Pyrun memory", () => {
	it("keeps RSS bounded when a restored child emits large Pyrun output while the parent waits", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Spawn a child before exec restart" });
			const initialMain = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				initialMain.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "post-restart-memory-child",
						prompt: "Remain live through exec restart",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const child = await pi.waitForAgent((agent) => agent.displayName === "post-restart-memory-child");
			const initialChild = await pi.waitForLlmRequest((request) => request.agentId === child.id);
			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMain.id,
			);
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const beforeRestart = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, child.id);
			if (!beforeRestart?.processIdentity?.pid) throw new Error("Missing pre-restart child ownership");
			const pid = beforeRestart.processIdentity.pid;
			const beforeRuntimeInstanceId = readMainRuntimeInstanceId(controlDbPath, pi.sessionId);

			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
			);
			const restoredChild = await pi.waitForLlmRequest(
				(request) => request.agentId === child.id && request.id !== initialChild.id,
			);
			await pi.send({ type: "prompt", message: "Wait for the restored child" });
			const restoredMain = await pi.waitForLlmRequest((request) => request.agentId === null);
			const afterRestart = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, child.id);
			const afterRuntimeInstanceId = readMainRuntimeInstanceId(controlDbPath, pi.sessionId);
			expect(afterRestart?.processIdentity?.pid).toBe(pid);
			expect(afterRuntimeInstanceId).not.toBe(beforeRuntimeInstanceId);

			pi.respondToLlmRequest(
				restoredMain.id,
				fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
			);
			await pi.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "wait_agent");
			pi.respondToLlmRequest(
				restoredChild.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code: `print('x' * ${LARGE_OUTPUT_BYTES})` }), {
					stopReason: "toolUse",
				}),
			);

			const baselineRssKiB = readRssKiB(pid);
			let peakRssKiB = baselineRssKiB;
			let completed = false;
			const monitor = (async () => {
				while (!completed) {
					peakRssKiB = Math.max(peakRssKiB, readRssKiB(pid));
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			})();
			let afterPyrun: HeadlessLlmRequest;
			try {
				afterPyrun = await pi.waitForLlmRequest(
					(request) => request.agentId === child.id && request.id !== restoredChild.id,
					30_000,
				);
			} finally {
				completed = true;
				await monitor;
			}
			pi.respondToLlmRequest(afterPyrun.id, fauxAssistantMessage("Large output complete"));

			const growthKiB = peakRssKiB - baselineRssKiB;
			expect(growthKiB).toBeLessThan(MAX_RSS_GROWTH_KIB);
		});
	}, 60_000);
});
