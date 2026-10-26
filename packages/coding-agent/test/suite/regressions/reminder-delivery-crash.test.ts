import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { createReminder, listReminders } from "../../../src/core/reminder-store.ts";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { type HeadlessPi, withHeadlessPi } from "../headless-pi.ts";

const fakeBins: string[] = [];

afterEach(() => {
	for (const directory of fakeBins.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A `notify-send` on PATH that records its arguments, one JSON line per alert. */
function recordingNotifySend(): { binDir: string; log: string } {
	const binDir = mkdtempSync(join(tmpdir(), "pi-notify-send-"));
	fakeBins.push(binDir);
	const log = join(binDir, "alerts.jsonl");
	const script = join(binDir, "notify-send");
	writeFileSync(
		script,
		`#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
	);
	chmodSync(script, 0o755);
	return { binDir, log };
}

function alerts(log: string): string[][] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The ID the running session reports; delivery compares the setting against it. */
async function runningSessionId(agent: HeadlessPi): Promise<string> {
	const state = await agent.send({ type: "get_state" });
	if (!state.success || state.command !== "get_state") throw new Error(`get_state failed: ${JSON.stringify(state)}`);
	return state.data.sessionId;
}

function endTurn(reason: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(fauxToolCall("end_turn", { reason }), { stopReason: "toolUse" });
}

function reminderEntries(agent: HeadlessPi) {
	return agent
		.readSessionEntries(null)
		.filter((entry) => entry.type === "custom_message" && entry.customType === "reminder");
}

it("redelivers a reminder queued behind a busy turn when the delivery process is killed", async () => {
	const { binDir, log } = recordingNotifySend();
	await withHeadlessPi(
		async (agent) => {
			const controlDb = getControlDbPath(agent.paths.agentDir);
			// Persist the session file so restarts reopen the same session ID.
			await agent.send({ type: "prompt", message: "Ready?" });
			const ready = await agent.waitForLlmRequest((request) => request.agentId === null);
			agent.respondToLlmRequest(ready.id, endTurn("Ready."));
			await agent.waitForEvent((event) => event.type === "agent_end");
			const sessionId = await runningSessionId(agent);
			writeFileSync(
				join(agent.paths.agentDir, "settings.json"),
				JSON.stringify({ reminders: { deliverySessionId: sessionId } }),
			);
			await agent.restart();
			expect(await runningSessionId(agent)).toBe(sessionId);

			await agent.send({ type: "prompt", message: "Long task" });
			await agent.waitForLlmRequest(
				(request) => request.agentId === null && request.userMessages.includes("Long task"),
			);
			const reminder = createReminder(controlDb, {
				title: "Security advisory recheck",
				dueAt: new Date().toISOString(),
			});
			// The minute timer finds it while the turn is busy and queues it behind that turn.
			await waitFor(() => alerts(log).length === 1, 75_000);
			expect(alerts(log)[0]).toEqual(["--app-name=pi", "Pi reminder", `#${reminder.id} Security advisory recheck`]);

			await agent.crash();
			expect(reminderEntries(agent)).toEqual([]);
			expect(listReminders(controlDb)[0].deliveredAt).toBeUndefined();

			await agent.restart();
			expect(await runningSessionId(agent)).toBe(sessionId);
			// The interrupted turn resumes first; the reminder must not take its place.
			const resumed = await agent.waitForLlmRequest((request) => request.agentId === null, 30_000);
			expect(resumed.userMessages.at(-1)).toBe("Long task");
			agent.respondToLlmRequest(resumed.id, fauxAssistantMessage("Resumed."));

			const answered = new Set([resumed]);
			let reminderTurns = 0;
			const deadline = Date.now() + 90_000;
			while (listReminders(controlDb)[0].deliveredAt === undefined) {
				const request = await agent.waitForLlmRequest(
					(candidate) => candidate.agentId === null && !answered.has(candidate),
					Math.max(1, deadline - Date.now()),
				);
				answered.add(request);
				if (request.userMessages.some((message) => message.includes("Security advisory recheck"))) reminderTurns++;
				agent.respondToLlmRequest(request.id, fauxAssistantMessage("Noted."));
				await waitFor(() => listReminders(controlDb)[0].deliveredAt !== undefined, 2_000).catch(() => undefined);
			}
			expect(reminderTurns).toBeGreaterThan(0);
			expect(reminderEntries(agent)).toHaveLength(1);
			expect(String((reminderEntries(agent)[0] as { content: unknown }).content)).toContain(
				"Security advisory recheck",
			);
			expect(alerts(log)).toHaveLength(2);
		},
		{ env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } },
	);
}, 240_000);
