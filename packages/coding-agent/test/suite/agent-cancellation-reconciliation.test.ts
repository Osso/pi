import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../src/core/sqlite.ts";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		process.kill(pid, "SIGKILL");
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(path: string): Promise<void> {
	await vi.waitFor(() => expect(existsSync(path)).toBe(true));
}

function readMainRuntimeIdentity(
	controlDbPath: string,
	sessionId: string,
): {
	incarnation: string;
	pid: number;
	startTimeTicks: number;
} {
	const db = createSqliteDatabase(controlDbPath);
	try {
		const row = db
			.prepare(
				`SELECT runtime_instance_id FROM runtime_mailbox_listeners
				 WHERE recipient_session_id = ? AND recipient_agent_id_key = ''`,
			)
			.get(sessionId) as { runtime_instance_id: string } | undefined;
		if (!row) throw new Error(`Missing main runtime listener for ${sessionId}`);
		return JSON.parse(row.runtime_instance_id) as {
			incarnation: string;
			pid: number;
			startTimeTicks: number;
		};
	} finally {
		db.close();
	}
}

async function spawnChildWithDetachedPyrun(pi: HeadlessPi, displayName: string) {
	const startedPath = join(pi.paths.workspaceDir, `${displayName}-started`);
	await pi.send({ type: "prompt", message: `Spawn ${displayName}` });
	const initialMain = await pi.waitForLlmRequest((request) => request.agentId === null);
	pi.respondToLlmRequest(
		initialMain.id,
		fauxAssistantMessage(
			fauxToolCall("spawn_agent", {
				context: "fresh",
				displayName,
				prompt: "Run a detached Pyrun evaluation until cancelled",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const child = await pi.waitForAgent((agent) => agent.displayName === displayName);
	const childSessionId = requireHeadlessAgentSessionId(child);
	const childRequest = await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
	const code = [
		"from pathlib import Path",
		"import time",
		`Path(${JSON.stringify(startedPath)}).write_text("started")`,
		"while True: time.sleep(0.05)",
	].join("\n");
	pi.respondToLlmRequest(
		childRequest.id,
		fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
	);
	const childAfterDetach = await pi.waitForLlmRequest(
		(request) => request.sessionId === childSessionId && request.id !== childRequest.id,
	);
	await waitForFile(startedPath);
	const detached = await pi.waitForAgent(
		(agent) =>
			agent.parentId === child.id && agent.displayName === "Pyrun evaluation" && agent.lifecycle === "running",
	);
	const mainAfterSpawn = await pi.waitForLlmRequest(
		(request) => request.agentId === null && request.id !== initialMain.id,
	);
	return { child, childAfterDetach, detached, mainAfterSpawn };
}

async function startForegroundPyrun(pi: HeadlessPi, requestId: string, markerName: string): Promise<void> {
	const markerPath = join(pi.paths.workspaceDir, markerName);
	const code = [
		"from pathlib import Path",
		"import time",
		`Path(${JSON.stringify(markerPath)}).write_text("started")`,
		"while True: time.sleep(0.05)",
	].join("\n");
	pi.respondToLlmRequest(
		requestId,
		fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
	);
	await waitForFile(markerPath);
}

function requestChildCancellation(pi: HeadlessPi, requestId: string, childId: string): void {
	pi.respondToLlmRequest(
		requestId,
		fauxAssistantMessage(fauxToolCall("close_agent", { agentId: childId, reason: "test cascading cancellation" }), {
			stopReason: "toolUse",
		}),
	);
}

describe("agent cancellation reconciliation", () => {
	it("terminalizes a cancelled child after its detached Pyrun descendant aborts out of process", async () => {
		await withHeadlessPi(
			async (pi) => {
				const { child, childAfterDetach, detached, mainAfterSpawn } = await spawnChildWithDetachedPyrun(
					pi,
					"Detached cancellation parent",
				);
				await startForegroundPyrun(pi, childAfterDetach.id, "detached-cancellation-foreground-started");
				requestChildCancellation(pi, mainAfterSpawn.id, child.id);

				await expect(
					pi.waitForAgent((agent) => agent.id === detached.id && agent.lifecycle === "aborted"),
				).resolves.toMatchObject({ id: detached.id, lifecycle: "aborted" });
				const abortedChild = await pi.waitForAgent(
					(agent) => agent.id === child.id && agent.lifecycle === "aborted",
				);
				expect(abortedChild).toMatchObject({ id: child.id, lifecycle: "aborted" });
				const afterClose = await pi.waitForLlmRequest(
					(request) => request.agentId === null && request.id !== mainAfterSpawn.id,
					15_000,
				);
				expect(JSON.stringify(afterClose.messages)).toContain("Cancelled Detached cancellation parent");
				pi.respondToLlmRequest(afterClose.id, fauxAssistantMessage("Cancellation complete"));
			},
			{ autoDetachTools: true, env: { PI_HEADLESS_TOOL_AUTO_DETACH_MS: "1000" } },
		);
	}, 30_000);
});

describe("agent cancellation restart recovery", () => {
	it("settles a cancelling child after restart_self supersedes its owner incarnation", async () => {
		await withHeadlessPi(
			async (pi) => {
				const { child, childAfterDetach, detached, mainAfterSpawn } = await spawnChildWithDetachedPyrun(
					pi,
					"Restart cancellation parent",
				);
				const runnerPid = pi.getRunnerPid(detached.id);
				if (!runnerPid) throw new Error("Detached Pyrun runner has no PID");
				killProcessGroup(runnerPid);
				await vi.waitFor(() => expect(isProcessAlive(runnerPid)).toBe(false));
				await startForegroundPyrun(pi, childAfterDetach.id, "restart-cancellation-foreground-started");

				requestChildCancellation(pi, mainAfterSpawn.id, child.id);
				await pi.waitForAgent((agent) => agent.id === detached.id && agent.lifecycle === "cancelling");
				await pi.waitForAgent((agent) => agent.id === child.id && agent.lifecycle === "cancelling");
				const afterClose = await pi.waitForLlmRequest(
					(request) => request.agentId === null && request.id !== mainAfterSpawn.id,
					15_000,
				);
				expect(JSON.stringify(afterClose.messages)).toContain("Cancellation requested");

				const controlDbPath = getControlDbPath(pi.paths.agentDir);
				const beforeRestart = readMainRuntimeIdentity(controlDbPath, pi.sessionId);
				pi.respondToLlmRequest(
					afterClose.id,
					fauxAssistantMessage(fauxToolCall("restart_self", {}), { stopReason: "toolUse" }),
				);
				const restoredMain = await pi.waitForLlmRequest((request) => request.agentId === null, 15_000);
				const afterRestart = readMainRuntimeIdentity(controlDbPath, pi.sessionId);
				expect(afterRestart).toMatchObject({
					pid: beforeRestart.pid,
					startTimeTicks: beforeRestart.startTimeTicks,
				});
				expect(afterRestart.incarnation).not.toBe(beforeRestart.incarnation);
				await expect(
					pi.waitForAgent((agent) => agent.id === detached.id && agent.lifecycle === "aborted"),
				).resolves.toMatchObject({ id: detached.id, lifecycle: "aborted" });
				await expect(
					pi.waitForAgent((agent) => agent.id === child.id && agent.lifecycle === "aborted"),
				).resolves.toMatchObject({ error: { code: "lost_runtime" }, id: child.id, lifecycle: "aborted" });
				pi.respondToLlmRequest(restoredMain.id, fauxAssistantMessage("Restart recovery complete"));
			},
			{ autoDetachTools: true, env: { PI_HEADLESS_TOOL_AUTO_DETACH_MS: "1000" } },
		);
	}, 40_000);
});
