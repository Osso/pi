import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "../headless-pi.ts";

const HOUR_MS = 60 * 60 * 1000;

function fauxCompletedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

// Clones the live child's persisted row into terminal history rows while the supervisor is down.
function seedTerminalHistory(pi: HeadlessPi, liveChildId: string): void {
	const db = createSqliteDatabase(getControlDbPath(pi.paths.agentDir));
	const old = new Date(Date.now() - 25 * HOUR_MS).toISOString();
	const recent = new Date(Date.now() - HOUR_MS).toISOString();
	const jobOutput = JSON.stringify([{ label: "Pyrun output", path: "/agent/detached-jobs/s/old_job/output.log" }]);
	const history: Array<[id: string, updatedAt: string, fileRefs: string]> = [
		["expired_history_1", old, "[]"],
		["expired_history_2", old, "[]"],
		["recent_history", recent, "[]"],
		["old_job_history", old, jobOutput],
	];
	try {
		const insert = db.prepare(`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
			SELECT session_path, ?, json_set(data, '$.id', ?, '$.displayName', ?, '$.lifecycle', 'completed',
				'$.updatedAt', ?, '$.result', json_object('summary', 'done', 'fileRefs', json(?))), updated_at
			FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?`);
		db.exec("BEGIN IMMEDIATE");
		for (const [id, updatedAt, fileRefs] of history) {
			insert.run(id, id, id, updatedAt, fileRefs, pi.sessionFile, liveChildId);
		}
		db.exec("COMMIT");
	} finally {
		db.close();
	}
}

function readPersistedAgentIds(pi: HeadlessPi): string[] {
	const db = createSqliteDatabase(getControlDbPath(pi.paths.agentDir));
	try {
		const rows = db
			.prepare("SELECT agent_id FROM multi_agent_agents WHERE session_path = ? ORDER BY agent_id")
			.all(pi.sessionFile) as Array<{ agent_id: string }>;
		return rows.map((row) => row.agent_id);
	} finally {
		db.close();
	}
}

describe("terminal agent row expiry across a supervisor restart", () => {
	it("expires old terminal history while the live child keeps its identity and completes once", async () => {
		await withHeadlessPi(async (pi) => {
			await pi.send({ type: "prompt", message: "Start a child that outlives terminal history" });
			const mainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(
				mainRequest.id,
				fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Expiry survivor",
						prompt: "Keep working until Pi restarts",
					}),
					{ stopReason: "toolUse" },
				),
			);
			const spawned = await pi.waitForAgent((agent) => agent.displayName === "Expiry survivor");
			const childSessionId = requireHeadlessAgentSessionId(spawned);
			await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);

			await pi.crash();
			seedTerminalHistory(pi, spawned.id);
			await pi.restart();

			const restoredRequest = await pi.waitForLlmRequest((request) => request.sessionId === childSessionId);
			expect(pi.listAgents().find((agent) => agent.id === spawned.id)).toMatchObject({
				lifecycle: "running",
				transcript: { path: spawned.transcript?.path, sessionId: childSessionId },
			});
			expect(readPersistedAgentIds(pi)).toEqual(["old_job_history", "recent_history", spawned.id].sort());

			const restoredMainRequest = await pi.waitForLlmRequest((request) => request.agentId === null);
			pi.respondToLlmRequest(restoredMainRequest.id, fauxCompletedAssistantMessage("Supervisor restored"));
			pi.respondToLlmRequest(restoredRequest.id, fauxCompletedAssistantMessage("Survivor work complete"));
			await pi.waitForAgent((agent) => agent.id === spawned.id && agent.lifecycle === "completed");
			const completionRequest = await pi.waitForLlmRequest(
				(request) =>
					request.agentId === null &&
					request.userMessages.some((message) => message.includes("Survivor work complete")),
			);
			expect(
				completionRequest.userMessages.filter((message) => message.includes("Survivor work complete")),
			).toHaveLength(1);
			pi.respondToLlmRequest(completionRequest.id, fauxCompletedAssistantMessage("Survivor report received"));
			await vi.waitFor(() => expect(readPersistedAgentIds(pi)).toContain(spawned.id));
		});
	});
});
