import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBlockedTurnMailboxAction } from "../src/core/blocked-turn-mailbox.ts";
import { registerRuntimeMailboxListener } from "../src/core/session-control-db.ts";
import { sendSupervisorInterrupt } from "../src/supervisor/interrupt.ts";

const SUPERVISOR = "supervisor-session";
const TARGET = { sessionId: "worker-session", agentId: null };

function turnStartedAt(timestamp: number): AgentMessage[] {
	return [{ role: "user", content: [{ type: "text", text: "work" }], timestamp }];
}

describe("Supervisor interrupt of a blocked turn", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-blocked-turn-"));
		controlDbPath = join(tempDir, "control.sqlite");
		registerRuntimeMailboxListener(controlDbPath, TARGET, process.pid);
	});

	afterEach(() => rmSync(tempDir, { force: true, recursive: true }));

	function action(supervisor: { sessionId?: string; host?: string } | undefined, messages: AgentMessage[]) {
		return readBlockedTurnMailboxAction({
			controlDbPath,
			recipient: TARGET,
			messages,
			supervisor,
			toolDetachRegistry: undefined,
		});
	}

	it("stops only a turn that began before the configured Supervisor's interrupt was sent", () => {
		const startedBefore = Date.now() - 60_000;
		sendSupervisorInterrupt(controlDbPath, SUPERVISOR, { sessionId: TARGET.sessionId }, "stuck build");

		expect(action({ sessionId: SUPERVISOR }, turnStartedAt(startedBefore))).toBe("interrupt");
		// A turn that began after the interrupt was sent is a later one; the stale interrupt must not stop it.
		expect(action({ sessionId: SUPERVISOR }, turnStartedAt(Date.now() + 60_000))).toBeUndefined();
	});

	it("ignores interrupts from any session but the configured Supervisor on its configured host", () => {
		const startedBefore = Date.now() - 60_000;
		sendSupervisorInterrupt(controlDbPath, "another-session", { sessionId: TARGET.sessionId }, "stop");

		expect(action({ sessionId: SUPERVISOR }, turnStartedAt(startedBefore))).toBeUndefined();
		expect(action(undefined, turnStartedAt(startedBefore))).toBeUndefined();

		sendSupervisorInterrupt(controlDbPath, SUPERVISOR, { sessionId: TARGET.sessionId }, "stop");
		// The configured Supervisor runs on another host, so a locally queued interrupt did not come from it.
		expect(action({ sessionId: SUPERVISOR, host: "supervisor-host" }, turnStartedAt(startedBefore))).toBeUndefined();
		expect(action({ sessionId: SUPERVISOR }, turnStartedAt(startedBefore))).toBe("interrupt");
	});
});
