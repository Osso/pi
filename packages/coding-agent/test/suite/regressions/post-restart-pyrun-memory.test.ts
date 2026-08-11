import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { getControlDbPath, readMultiAgentRuntimeOwnership } from "../../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";
import { type HeadlessLlmRequest, withHeadlessPi } from "../headless-pi.ts";

const LARGE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RSS_GROWTH_KIB = 512 * 1024;

function requireSessionId(sessionId: string | undefined): string {
	if (!sessionId) throw new Error("Spawned child has no session ID");
	return sessionId;
}

function readRssKiB(pid: number): number {
	const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m);
	if (!match) throw new Error(`Missing VmRSS for process ${pid}`);
	return Number(match[1]);
}

const RSS_SAMPLER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");

function readRssKiB(pid) {
  const match = readFileSync("/proc/" + pid + "/status", "utf8").match(/^VmRSS:\\s+(\\d+)\\s+kB$/m);
  if (!match) throw new Error("Missing VmRSS for process " + pid);
  return Number(match[1]);
}

function readPeaks(pids, previousPeaks) {
  const peaks = { ...previousPeaks };
  for (const pid of pids) {
    const key = String(pid);
    peaks[key] = Math.max(peaks[key] ?? 0, readRssKiB(pid));
  }
  return peaks;
}

let peakRssKiBByPid = readPeaks(workerData.pids, {});
const timer = setInterval(() => {
  peakRssKiBByPid = readPeaks(workerData.pids, peakRssKiBByPid);
}, workerData.intervalMs);

parentPort.postMessage({ type: "ready" });
parentPort.on("message", (message) => {
  if (message !== "stop") return;
  clearInterval(timer);
  peakRssKiBByPid = readPeaks(workerData.pids, peakRssKiBByPid);
  parentPort.postMessage({ peakRssKiBByPid, type: "stopped" });
  parentPort.close();
});
`;

type RssPeaks = Record<string, number>;
type RssSamplerMessage = { type: "ready" } | { peakRssKiBByPid: RssPeaks; type: "stopped" };

async function waitForRssSamplerMessage(worker: Worker): Promise<RssSamplerMessage> {
	const [message] = (await once(worker, "message")) as [RssSamplerMessage];
	return message;
}

function startWorkerRssSampler(pids: number[]): {
	ready: Promise<void>;
	stop: () => Promise<RssPeaks>;
} {
	const worker = new Worker(RSS_SAMPLER_SOURCE, {
		eval: true,
		workerData: { intervalMs: 5, pids },
	});
	const ready = waitForRssSamplerMessage(worker).then((message) => {
		if (message.type !== "ready") throw new Error(`Expected RSS sampler ready message, received ${message.type}`);
	});
	return {
		ready,
		stop: async () => {
			try {
				await ready;
				const stopped = waitForRssSamplerMessage(worker);
				worker.postMessage("stop");
				const message = await stopped;
				if (message.type !== "stopped") {
					throw new Error(`Expected RSS sampler stopped message, received ${message.type}`);
				}
				return message.peakRssKiBByPid;
			} finally {
				await worker.terminate();
			}
		},
	};
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
			const childSessionId = requireSessionId(child.transcript?.sessionId);
			await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
			const mainAfterSpawn = await pi.waitForLlmRequest(
				(request) => request.agentId === null && request.id !== initialMain.id,
			);
			const controlDbPath = getControlDbPath(pi.paths.agentDir);
			const beforeRestart = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, child.id);
			if (!beforeRestart?.processIdentity?.pid) throw new Error("Missing pre-restart child ownership");
			const restoredChildProcessId = beforeRestart.processIdentity.pid;
			const beforeRuntimeInstanceId = readMainRuntimeInstanceId(controlDbPath, pi.sessionId);

			pi.respondToLlmRequest(
				mainAfterSpawn.id,
				fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
			);
			const restoredMain = await pi.waitForLlmRequest((request) => request.agentId === null);
			const afterRestart = readMultiAgentRuntimeOwnership(controlDbPath, pi.sessionFile, child.id);
			const afterRuntimeInstanceId = readMainRuntimeInstanceId(controlDbPath, pi.sessionId);
			expect(afterRestart?.processIdentity?.pid).toBe(restoredChildProcessId);
			expect(afterRuntimeInstanceId).not.toBe(beforeRuntimeInstanceId);

			pi.respondToLlmRequest(
				restoredMain.id,
				fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
			);
			await pi.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "wait_agent");
			const restoredChild = await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
			pi.respondToLlmRequest(
				restoredChild.id,
				fauxAssistantMessage(fauxToolCall("pyrun_eval", { code: `print('x' * ${LARGE_OUTPUT_BYTES})` }), {
					stopReason: "toolUse",
				}),
			);

			const baselineRssKiBByPid = {
				[String(process.pid)]: readRssKiB(process.pid),
				[String(restoredChildProcessId)]: readRssKiB(restoredChildProcessId),
			};
			const workerRssSampler = startWorkerRssSampler([process.pid, restoredChildProcessId]);
			let afterPyrun: HeadlessLlmRequest | undefined;
			let peakRssKiBByPid: RssPeaks | undefined;
			try {
				await workerRssSampler.ready;
				afterPyrun = await pi.waitForLlmRequest((request) => request.sessionId === childSessionId, 30_000);
			} finally {
				peakRssKiBByPid = await workerRssSampler.stop();
			}
			if (!peakRssKiBByPid) {
				throw new Error("RSS sampler completed without recording process peaks");
			}
			const restoredChildRssGrowthKiB =
				peakRssKiBByPid[String(restoredChildProcessId)] - baselineRssKiBByPid[String(restoredChildProcessId)];
			const testWorkerRssGrowthKiB = peakRssKiBByPid[String(process.pid)] - baselineRssKiBByPid[String(process.pid)];
			if (!afterPyrun) {
				throw new Error("RSS sampler completed without a Pyrun continuation request");
			}
			pi.respondToLlmRequest(afterPyrun.id, fauxAssistantMessage("Large output complete"));

			expect(restoredChildRssGrowthKiB).toBeLessThan(MAX_RSS_GROWTH_KIB);
			expect(testWorkerRssGrowthKiB).toBeLessThan(MAX_RSS_GROWTH_KIB);
		});
	}, 60_000);
});
