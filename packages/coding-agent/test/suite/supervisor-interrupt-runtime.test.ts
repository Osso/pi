import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { runHostRelay } from "../../src/core/host-relay.ts";
import { isProcessIdentityAlive, type ProcessIdentity, readProcessIdentity } from "../../src/core/runtime-process.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { sendSupervisorInterrupt } from "../../src/supervisor/interrupt.ts";
import { HEADLESS_SUPERVISOR_SESSION_ID } from "./fixtures/headless-supervisor.ts";
import { type HeadlessPi, requireHeadlessAgentSessionId, withHeadlessPi } from "./headless-pi.ts";

const SUPERVISOR_HOST = "supervisor-host";
const TARGET_HOST = "target-host";

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await delay(50);
	}
}

/** Connects a stand-in Supervisor host's control DB to the target Pi's control DB, as `pi relay` does over SSH. */
function connectHosts(supervisorDb: string, targetDb: string, signal: AbortSignal): void {
	const toTarget = new PassThrough();
	const toSupervisor = new PassThrough();
	const common = { pollMs: 20, signal };
	void runHostRelay({
		...common,
		controlDbPath: supervisorDb,
		host: SUPERVISOR_HOST,
		input: toSupervisor,
		output: toTarget,
	});
	void runHostRelay({ ...common, controlDbPath: targetDb, host: TARGET_HOST, input: toTarget, output: toSupervisor });
}

/** Starts a child agent whose model request stays open, then a main-turn Bash call that never ends. */
async function blockMainTurnInBash(agent: HeadlessPi): Promise<{ childId: string; shell: ProcessIdentity }> {
	await agent.send({ type: "prompt", message: "Start the background worker, then run the long command" });
	const first = await agent.waitForLlmRequest((request) => request.agentId === null);
	agent.respondToLlmRequest(
		first.id,
		fauxAssistantMessage(
			[fauxToolCall("spawn_agent", { context: "fresh", displayName: "Unrelated worker", prompt: "Keep working" })],
			{ stopReason: "toolUse" },
		),
	);
	const child = await agent.waitForAgent((candidate) => candidate.displayName === "Unrelated worker");
	const childSessionId = requireHeadlessAgentSessionId(child);
	await agent.waitForLlmRequest((request) => request.sessionId === childSessionId);
	const second = await agent.waitForLlmRequest((request) => request.agentId === null && request.id !== first.id);
	const pidFile = join(agent.paths.workspaceDir, "shell.pid");
	agent.respondToLlmRequest(
		second.id,
		fauxAssistantMessage([fauxToolCall("bash", { command: `echo $$ > ${pidFile}; sleep 600` })], {
			stopReason: "toolUse",
		}),
	);
	const pid = await waitFor(
		() =>
			existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()
				? Number(readFileSync(pidFile, "utf8"))
				: undefined,
		"the blocking Bash shell",
	);
	const shell = readProcessIdentity(pid);
	if (!shell) throw new Error(`Bash shell ${pid} exited before the interrupt`);
	return { childId: child.id, shell };
}

describe("Supervisor interrupt through the relay", () => {
	it("stops a main turn blocked in Bash and continues it, only for the configured Supervisor", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-interrupt-"));
		const supervisorDb = join(tempDir, "supervisor-host.sqlite");
		const relay = new AbortController();
		try {
			await withHeadlessPi(
				async (agent) => {
					connectHosts(supervisorDb, getControlDbPath(agent.paths.agentDir), relay.signal);
					const before = await agent.send({ type: "get_state" });
					const { childId, shell } = await blockMainTurnInBash(agent);
					await agent.send({ type: "prompt", message: "then summarize", streamingBehavior: "followUp" });
					const target = { sessionId: agent.sessionId, host: TARGET_HOST };

					// The right session ID from the Supervisor's host, but not the Supervisor session: ignored.
					sendSupervisorInterrupt(supervisorDb, "not-the-supervisor", target, "impostor stop");
					await waitFor(
						() =>
							agent.listRuntimeMailboxMessages().some((m) => m.sender.sessionId === "not-the-supervisor")
								? true
								: undefined,
						"the relayed impostor interrupt",
					);
					await delay(1_500);
					expect(isProcessIdentityAlive(shell)).toBe(true);

					sendSupervisorInterrupt(
						supervisorDb,
						HEADLESS_SUPERVISOR_SESSION_ID,
						target,
						"the build is stuck; skip it",
					);
					await waitFor(() => (isProcessIdentityAlive(shell) ? undefined : true), "the Bash shell to be killed");
					const resumed = await agent.waitForLlmRequest(
						(request) =>
							request.agentId === null &&
							request.userMessages.some((text) => text.includes("the build is stuck; skip it")),
					);
					expect(resumed.userMessages.join("\n")).toContain(`- host: ${SUPERVISOR_HOST}`);
					const endTurn = (id: string) =>
						agent.respondToLlmRequest(
							id,
							fauxAssistantMessage(
								[{ type: "text", text: "Done." }, fauxToolCall("end_turn", { reason: "Done" })],
								{
									stopReason: "toolUse",
								},
							),
						);
					endTurn(resumed.id);
					// The user's queued follow-up survives the interrupt.
					if (!resumed.userMessages.some((text) => text.includes("then summarize"))) {
						const followUp = await agent.waitForLlmRequest(
							(request) =>
								request.agentId === null &&
								request.userMessages.some((text) => text.includes("then summarize")),
						);
						endTurn(followUp.id);
					}
					await agent.waitForEvent((event) => event.type === "agent_settled");

					const after = await agent.send({ type: "get_state" });
					expect(after).toMatchObject({
						data: {
							sessionId: (before as { data: { sessionId: string } }).data.sessionId,
							sessionFile: (before as { data: { sessionFile: string } }).data.sessionFile,
						},
					});
					expect(agent.listAgents().find((candidate) => candidate.id === childId)?.lifecycle).toBe("running");
				},
				{ supervisorHost: SUPERVISOR_HOST },
			);
		} finally {
			relay.abort();
			rmSync(tempDir, { force: true, recursive: true });
		}
	}, 90_000);
});
