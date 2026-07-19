import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
import {
	commitMultiAgentLifecycleMutation,
	createMultiAgentChildWithRuntimeOwnership,
	getControlDbPath,
	readMultiAgentAgent,
	readMultiAgentRuntimeOwnership,
	reconcileDeadDetachedAgentRuntimes,
	registerRuntimeMailboxListener,
	writeSessionHealth,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

const CREATED_AT = "2026-07-16T12:00:00.000Z";
const CANCELLED_AT = "2026-07-16T12:00:01.000Z";
const RECONCILED_AT = "2026-07-16T12:00:02.000Z";
const DEAD_RUNNER = { pid: 2_000_000_000, startTimeTicks: 1 };
const OWNER_SESSION_ID = "dead-owner-session";
const SESSION_PATH = "/sessions/dead-owner.jsonl";
const JOB_ID = "pyrun_1";

function createOwnerSession(controlDbPath: string): void {
	writeSessionMetadata(controlDbPath, {
		allMessagesText: "owner",
		createdAt: CREATED_AT,
		cwd: "/repo",
		firstMessage: "owner",
		id: OWNER_SESSION_ID,
		messageCount: 1,
		modifiedAt: CREATED_AT,
		sessionPath: SESSION_PATH,
	});
	writeSessionHealth(controlDbPath, {
		...emptySessionHealth(OWNER_SESSION_ID, CREATED_AT),
		agentGeneration: 1,
		checkedGeneration: 1,
		checkStatus: "dead",
	});
}

function createRunningDetachedJob(controlDbPath: string): void {
	const created = createMultiAgentChildWithRuntimeOwnership(controlDbPath, {
		agent: {
			agentType: "background",
			createdAt: CREATED_AT,
			cwd: "/repo",
			detached: true,
			displayName: "Pyrun evaluation",
			id: JOB_ID,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			result: { fileRefs: [{ label: "Pyrun output", path: "/tmp/pyrun-output.log" }] },
			revision: 1,
			updatedAt: CREATED_AT,
			worker: { adapter: "runtime", handleId: String(DEAD_RUNNER.pid), toolCallId: "tool_1" },
		},
		agentId: JOB_ID,
		nowIso: CREATED_AT,
		owner: { agentId: null, sessionId: OWNER_SESSION_ID },
		processIdentity: DEAD_RUNNER,
		sessionPath: SESSION_PATH,
	});
	if (!created.ok) throw new Error(`Could not create detached test job: ${created.error}`);
}

function requestDetachedCancellation(controlDbPath: string): void {
	const cancelling = commitMultiAgentLifecycleMutation(controlDbPath, {
		agentId: JOB_ID,
		detachedCancellation: { outputLabel: "Pyrun output", reason: "test cancellation" },
		owner: { agentId: null, sessionId: OWNER_SESSION_ID },
		processIdentity: DEAD_RUNNER,
		requestedLifecycle: "cancelling",
		sessionPath: SESSION_PATH,
		updatedAt: CANCELLED_AT,
	});
	if (!cancelling.ok) throw new Error(`Could not cancel detached test job: ${cancelling.error}`);
}

function countTerminalOutboxRows(controlDbPath: string): number {
	const db = createSqliteDatabase(controlDbPath);
	try {
		return (
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM multi_agent_terminal_outbox WHERE session_path = ? AND agent_id = ?",
				)
				.get(SESSION_PATH, JOB_ID) as { count: number }
		).count;
	} finally {
		db.close();
	}
}

function replaceRunnerIdentity(controlDbPath: string, processIdentity: { pid: number; startTimeTicks: number }): void {
	const db = createSqliteDatabase(controlDbPath);
	try {
		const row = db
			.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
			.get(SESSION_PATH, JOB_ID) as { data: string };
		const agent = JSON.parse(row.data) as Record<string, unknown>;
		db.prepare("UPDATE multi_agent_agents SET data = ? WHERE session_path = ? AND agent_id = ?").run(
			JSON.stringify({
				...agent,
				worker: { adapter: "runtime", handleId: String(processIdentity.pid), toolCallId: "tool_1" },
			}),
			SESSION_PATH,
			JOB_ID,
		);
		db.prepare(
			"UPDATE multi_agent_runtime_owners SET process_identity = ? WHERE session_path = ? AND agent_id = ?",
		).run(JSON.stringify(processIdentity), SESSION_PATH, JOB_ID);
	} finally {
		db.close();
	}
}

describe("orphaned detached runtime reconciliation", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-orphaned-detached-"));
		controlDbPath = getControlDbPath(tempDir);
		createOwnerSession(controlDbPath);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("settles a dead-runner cancellation owned by a sticky-dead historical session", () => {
		createRunningDetachedJob(controlDbPath);
		requestDetachedCancellation(controlDbPath);

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(1);
		const reconciled = readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID);
		expect(reconciled).toMatchObject({
			error: { code: "lost_runtime" },
			lifecycle: "aborted",
			result: { toolCallId: "tool_1" },
			revision: 3,
		});
		expect(reconciled?.worker).toBeUndefined();
		expect(readMultiAgentRuntimeOwnership(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			owner: { agentId: null, sessionId: undefined },
			processIdentity: undefined,
		});
		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(0);
		expect(countTerminalOutboxRows(controlDbPath)).toBe(1);
	});

	it("settles a dead detached running job while its logical parent session is live", () => {
		createRunningDetachedJob(controlDbPath);
		const currentProcess = readProcessIdentity(process.pid);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: OWNER_SESSION_ID },
			process.pid,
			SESSION_PATH,
			{ runtimeInstanceId: JSON.stringify(currentProcess) },
		);

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(1);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			error: { code: "lost_runtime" },
			lifecycle: "failed",
			result: { toolCallId: "tool_1" },
			revision: 2,
		});
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)?.worker).toBeUndefined();
		expect(readMultiAgentRuntimeOwnership(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			owner: { agentId: null, sessionId: undefined },
			processIdentity: undefined,
		});
		expect(countTerminalOutboxRows(controlDbPath)).toBe(1);
	});

	it("does not settle a running job while its exact replacement runner identity is alive", () => {
		createRunningDetachedJob(controlDbPath);
		const currentProcess = readProcessIdentity(process.pid);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: OWNER_SESSION_ID },
			process.pid,
			SESSION_PATH,
			{ runtimeInstanceId: JSON.stringify(currentProcess) },
		);
		replaceRunnerIdentity(controlDbPath, currentProcess);

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(0);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			lifecycle: "running",
			revision: 1,
		});
		expect(countTerminalOutboxRows(controlDbPath)).toBe(0);
	});

	it("does not settle a cancellation while its exact runner process is alive", () => {
		createRunningDetachedJob(controlDbPath);
		requestDetachedCancellation(controlDbPath);
		replaceRunnerIdentity(controlDbPath, readProcessIdentity(process.pid));

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(0);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			lifecycle: "cancelling",
			revision: 2,
		});
	});

	it("does not confuse a reused PID with the dead recorded runner identity", () => {
		createRunningDetachedJob(controlDbPath);
		requestDetachedCancellation(controlDbPath);
		const current = readProcessIdentity(process.pid);
		replaceRunnerIdentity(controlDbPath, { pid: current.pid, startTimeTicks: current.startTimeTicks - 1 });

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(1);
		expect(readProcessIdentity(process.pid)).toEqual(current);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({ lifecycle: "aborted" });
	});

	it("does not settle a cancellation while it has an active descendant", () => {
		createRunningDetachedJob(controlDbPath);
		requestDetachedCancellation(controlDbPath);
		const child = createMultiAgentChildWithRuntimeOwnership(controlDbPath, {
			agent: {
				agentType: "worker",
				createdAt: CREATED_AT,
				cwd: "/repo",
				displayName: "Active descendant",
				id: "agent_child",
				lifecycle: "running",
				parentId: JOB_ID,
				permission: { narrowed: true, policy: "on-request" },
				revision: 1,
				updatedAt: CREATED_AT,
			},
			agentId: "agent_child",
			nowIso: CREATED_AT,
			owner: { agentId: JOB_ID, sessionId: OWNER_SESSION_ID },
			processIdentity: { pid: DEAD_RUNNER.pid - 1, startTimeTicks: 1 },
			sessionPath: SESSION_PATH,
		});
		if (!child.ok) throw new Error(`Could not create active descendant: ${child.error}`);

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(0);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({ lifecycle: "cancelling" });
	});

	it("does not duplicate a cancellation that already has a terminal outbox record", () => {
		createRunningDetachedJob(controlDbPath);
		requestDetachedCancellation(controlDbPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`INSERT INTO multi_agent_terminal_outbox
				 (session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
				 VALUES (?, ?, 2, 'lost_runtime', 'pending', 0, ?)`,
			).run(SESSION_PATH, JOB_ID, CANCELLED_AT);
		} finally {
			db.close();
		}

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(0);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			lifecycle: "cancelling",
			revision: 2,
		});
		expect(countTerminalOutboxRows(controlDbPath)).toBe(1);
	});

	it("does not settle a cancellation whose worker handle does not identify the recorded runner", () => {
		createRunningDetachedJob(controlDbPath);
		requestDetachedCancellation(controlDbPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(SESSION_PATH, JOB_ID) as { data: string };
			const agent = JSON.parse(row.data) as Record<string, unknown>;
			db.prepare("UPDATE multi_agent_agents SET data = ? WHERE session_path = ? AND agent_id = ?").run(
				JSON.stringify({
					...agent,
					worker: { adapter: "runtime", handleId: "different-runner", toolCallId: "tool_1" },
				}),
				SESSION_PATH,
				JOB_ID,
			);
		} finally {
			db.close();
		}

		expect(reconcileDeadDetachedAgentRuntimes(controlDbPath, RECONCILED_AT)).toBe(0);
		expect(readMultiAgentAgent(controlDbPath, SESSION_PATH, JOB_ID)).toMatchObject({
			lifecycle: "cancelling",
			revision: 2,
		});
		expect(readMultiAgentRuntimeOwnership(controlDbPath, SESSION_PATH, JOB_ID)?.processIdentity).toEqual(DEAD_RUNNER);
	});
});
