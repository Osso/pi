import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessIdentity } from "../src/core/runtime-process.ts";
import {
	getRuntimeProcessInstanceId,
	readLiveRuntimeMailboxSessionAgentIds,
	withControlDb,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";

const currentRuntimeIdentity = getRuntimeProcessInstanceId();
const currentProcessIdentity = JSON.parse(currentRuntimeIdentity) as ProcessIdentity;
const sessionId = "target ' ? % session";

function insertListener(
	controlDbPath: string,
	targetSessionId: string,
	agentId: string | null,
	identity: string | null,
) {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`INSERT INTO runtime_mailbox_listeners
			 (recipient_session_id, recipient_agent_id_key, pid, runtime_instance_id, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(
			targetSessionId,
			agentId ?? "",
			identity ? (JSON.parse(identity) as ProcessIdentity).pid : process.pid,
			identity,
			new Date().toISOString(),
		);
	});
}

describe("live runtime mailbox session agent addresses", () => {
	let directory: string;
	let controlDbPath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-session-addresses-"));
		controlDbPath = join(directory, "control.sqlite");
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("returns no addresses when no listeners exist", () => {
		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual([]);
	});

	it("returns no addresses for a known offline main session", () => {
		const now = new Date().toISOString();
		writeSessionMetadata(controlDbPath, {
			sessionPath: join(directory, "offline.jsonl"),
			id: sessionId,
			cwd: directory,
			createdAt: now,
			modifiedAt: now,
			messageCount: 2,
			firstMessage: "Offline main session",
		});

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual([]);
	});

	it.each<{ label: string; agentIds: Array<string | null> }>([
		{ label: "child listeners without a main listener", agentIds: ["child-1", "child-2"] },
		{ label: "a main listener mapped to null", agentIds: [null] },
		{ label: "both main and child listeners", agentIds: [null, "child-1"] },
	])("returns $label for the current runtime", ({ agentIds }) => {
		for (const agentId of agentIds) insertListener(controlDbPath, sessionId, agentId, currentRuntimeIdentity);

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual(expect.arrayContaining(agentIds));
		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toHaveLength(agentIds.length);
	});

	it("scopes addresses to the exact requested session", () => {
		insertListener(controlDbPath, sessionId, "child-1", currentRuntimeIdentity);
		insertListener(controlDbPath, `${sessionId}-other`, "child-1", currentRuntimeIdentity);
		insertListener(controlDbPath, `${sessionId}-other`, null, currentRuntimeIdentity);

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual(["child-1"]);
		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, "target")).toEqual([]);
	});

	it("excludes listeners belonging to an exited PID", () => {
		const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8", timeout: 10_000 });
		expect(exited.error).toBeUndefined();
		expect(exited.status).toBe(0);
		const pid = Number(exited.stdout.trim());
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		insertListener(controlDbPath, sessionId, "dead-child", JSON.stringify({ pid, startTimeTicks: 1 }));
		insertListener(controlDbPath, sessionId, "current-child", currentRuntimeIdentity);

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual(["current-child"]);
	});

	it("excludes a live PID whose persisted OS start identity no longer matches", () => {
		insertListener(
			controlDbPath,
			sessionId,
			"reused-pid-child",
			JSON.stringify({ ...currentProcessIdentity, startTimeTicks: currentProcessIdentity.startTimeTicks + 1 }),
		);

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual([]);
	});

	it("excludes a superseded incarnation of the current PID and OS start identity", () => {
		insertListener(
			controlDbPath,
			sessionId,
			null,
			JSON.stringify({ ...currentProcessIdentity, incarnation: `${currentProcessIdentity.incarnation}-superseded` }),
		);
		insertListener(controlDbPath, sessionId, "current-child", currentRuntimeIdentity);

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual(["current-child"]);
	});

	it.each([null, ""])("excludes listeners with missing runtime identity %j despite a live PID", (identity) => {
		insertListener(controlDbPath, sessionId, null, identity);
		insertListener(controlDbPath, sessionId, "unproven-child", identity);

		expect(readLiveRuntimeMailboxSessionAgentIds(controlDbPath, sessionId)).toEqual([]);
	});
});
