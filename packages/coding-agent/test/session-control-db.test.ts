import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDetachedJobArtifacts, createDetachedJobTerminalInput } from "../src/core/detached-job-runner.ts";
import {
	advanceSharedChannelCursor,
	allocateMultiAgentCounter,
	archiveSession,
	archiveSessionsOlderThan,
	bootstrapMultiAgentAgent,
	claimLatestIncomingMessage,
	claimMultiAgentTerminalOutbox,
	claimPendingArchitectRequests,
	claimRuntimeMailboxMessages,
	cleanupMultiAgentTerminalOutbox,
	commitMultiAgentDetachMark,
	commitMultiAgentLifecycleMutation,
	commitMultiAgentSteeringMutation,
	commitMultiAgentTerminalMutation,
	completeArchitectRequest,
	completeIncomingMessage,
	consumeRuntimeMailboxMessage,
	createMultiAgentChildWithRuntimeOwnership,
	deliverMultiAgentTerminalOutbox,
	deliverRuntimeMailboxMessage,
	enqueueIncomingMessage,
	enqueueRuntimeMailboxMessage,
	failMultiAgentTerminalOutbox,
	failRuntimeMailboxMessage,
	finalizeDetachedJob,
	getControlDbPath,
	initializeSharedChannelCursorAtTail,
	listActiveSessionMetadata,
	listArchivedSessionMetadata,
	listNamedSessions,
	listPendingArchitectRequests,
	listRuntimeMailboxListeners,
	listRuntimeMailboxMessages,
	listSessionMetadata,
	listSharedChannelMessagesAfter,
	markMultiAgentMailboxMessageDelivered,
	markRuntimeMailboxMessageDelivered,
	postArchitectRequest,
	postSharedChannelMessage,
	prepareControlDbForSelfRestart,
	readIncomingMessageStatus,
	readLastMessage,
	readMultiAgentRuntimeOwnership,
	readMultiAgentState,
	readRuntimeMailboxMessage,
	readSessionGoal,
	readSessionHealth,
	readSessionMetadata,
	readSharedChannelCursor,
	recoverDeadMultiAgentRuntime,
	recoverDeadRuntimeMailboxClaims,
	registerRuntimeMailboxListener,
	relocateSessionControlData,
	removeNamedSession,
	renewArchitectRequestClaims,
	resolveOwnMainRuntimeCoordinationRecipient,
	retainControlDbConnection,
	retireRuntimeMailboxListener,
	setNamedSession,
	unarchiveSession,
	updateMultiAgentAgentActivity,
	updateMultiAgentAgentCurrentActivity,
	updateMultiAgentAgentSlot,
	updateMultiAgentAgentTranscript,
	upsertMultiAgentMailboxMessage,
	writeLastMessage,
	writeSessionGoal,
	writeSessionHealth,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";
import {
	configureReadOnlySqliteDatabase,
	configureSharedSqliteDatabase,
	createReadOnlySqliteDatabase,
	createSqliteDatabase,
} from "../src/core/sqlite.ts";
import { CURRENT_PROCESS_IDENTITY, testProcessIdentity } from "./helpers/process-identity.ts";
import { forceRuntimeOwnership } from "./helpers/runtime-ownership.ts";

let storedMessageCounter = 0;

type SpawnedChildProcess = ChildProcess & { pid: number };

async function spawnIdleNodeProcess(): Promise<SpawnedChildProcess> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	if (child.pid === undefined) throw new Error("Spawned child process has no pid");
	return child as SpawnedChildProcess;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill();
	await exited;
}

function claimTestRuntimeMailboxMessages(
	controlDbPath: string,
	recipient: Parameters<typeof claimRuntimeMailboxMessages>[1],
) {
	registerRuntimeMailboxListener(controlDbPath, recipient, process.pid);
	return claimRuntimeMailboxMessages(controlDbPath, recipient);
}

function enqueueStoredRuntimeMessage(
	controlDbPath: string,
	input: {
		body: string;
		kind: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["kind"];
		recipient: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["recipient"];
		sender: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["sender"];
		fileRefs?: Array<{ path: string; label?: string }>;
	},
): number {
	storedMessageCounter += 1;
	const messageId = `message_${storedMessageCounter}`;
	const sessionPath = "/sessions/test-sender.jsonl";
	registerRuntimeMailboxListener(controlDbPath, input.recipient, process.pid);
	upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
		fileRefs: input.fileRefs,
		body: input.body,
		fromAgentId: input.sender.agentId ?? "main",
		id: messageId,
		kind: input.kind,
		status: "pending",
		toAgentId: input.recipient.agentId ?? "main",
	});
	return enqueueRuntimeMailboxMessage(controlDbPath, {
		kind: input.kind,
		recipient: input.recipient,
		sender: input.sender,
		storeRef: { messageId, sessionPath },
	});
}

describe("session control DB", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-control-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("stores control state next to the session transcript", () => {
		expect(controlDbPath).toBe(join(tempDir, "control.sqlite"));
	});

	it("allows concurrent writes while a process-local control DB connection is retained", () => {
		const release = retainControlDbConnection(controlDbPath);
		try {
			enqueueIncomingMessage(controlDbPath, "retained connection write");
			const competingWriter = createSqliteDatabase(controlDbPath);
			try {
				configureSharedSqliteDatabase(competingWriter);
				competingWriter
					.prepare("INSERT INTO incoming_messages (content, status, created_at) VALUES (?, 'pending', ?)")
					.run("competing write", "2026-07-16T00:00:00.000Z");
			} finally {
				competingWriter.close();
			}
			expect(claimLatestIncomingMessage(controlDbPath)?.content).toBe("competing write");
		} finally {
			release();
		}
	});

	it("does not reuse mailbox IDs when persisted rows or an alternate counter table are ahead", () => {
		const sessionPath = "/sessions/supervisor.jsonl";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_2", {
			body: "already allocated",
			fromAgentId: "agent_3",
			id: "message_2",
			kind: "system",
			status: "delivered",
			toAgentId: "main",
		});

		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE multi_agent_counters (
					session_path TEXT PRIMARY KEY,
					next_agent_number INTEGER NOT NULL,
					next_artifact_number INTEGER NOT NULL,
					next_message_number INTEGER NOT NULL,
					updated_at TEXT NOT NULL
				);
				INSERT INTO multi_agent_counters (
					session_path, next_agent_number, next_artifact_number, next_message_number, updated_at
				) VALUES ('${sessionPath}', 1, 1, 1, '2026-07-11T00:00:00.000Z');
				INSERT INTO multi_agent_counters_v2 (
					session_path, next_agent_number, next_message_number, updated_at
				) VALUES ('${sessionPath}', 1, 7, '2026-07-11T00:00:00.000Z');
			`);
		} finally {
			db.close();
		}

		expect(allocateMultiAgentCounter(controlDbPath, sessionPath, "message")).toBe(7);
		const verifyDb = createSqliteDatabase(controlDbPath);
		try {
			expect(
				verifyDb
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_counters'")
					.get(),
			).toBeUndefined();
		} finally {
			verifyDb.close();
		}
	});

	it("persists Architect requests until the Architect completes them", () => {
		const requestId = postArchitectRequest(controlDbPath, {
			senderSessionId: "main-session",
			body: "Architect: inspect this request",
		});

		expect(listPendingArchitectRequests(controlDbPath)).toEqual([
			expect.objectContaining({
				id: requestId,
				senderSessionId: "main-session",
				body: "Architect: inspect this request",
				status: "pending",
			}),
		]);

		const claimed = claimPendingArchitectRequests(controlDbPath, "architect-runtime");
		expect(claimed.map((request) => request.id)).toEqual([requestId]);
		expect(claimPendingArchitectRequests(controlDbPath, "competing-runtime")).toEqual([]);

		completeArchitectRequest(controlDbPath, requestId, "architect-runtime");
		expect(listPendingArchitectRequests(controlDbPath)).toEqual([]);
	});

	it("rolls back all Architect claim renewals when one renewal fails", () => {
		const requestIds = ["first", "second"].map((body) =>
			postArchitectRequest(controlDbPath, { senderSessionId: "main-session", body }),
		);
		claimPendingArchitectRequests(controlDbPath, "architect-runtime", 2);
		const db = createSqliteDatabase(controlDbPath);
		const originalClaimedAt = "2020-01-01T00:00:00.000Z";
		try {
			db.prepare("UPDATE architect_requests SET claimed_at = ? WHERE claim_token = ?").run(
				originalClaimedAt,
				"architect-runtime",
			);
			db.exec(`
				CREATE TRIGGER reject_second_architect_renewal
				BEFORE UPDATE OF claimed_at ON architect_requests
				WHEN OLD.id = ${requestIds[1]}
				BEGIN
					SELECT RAISE(ABORT, 'reject renewal');
				END
			`);
		} finally {
			db.close();
		}

		expect(() => renewArchitectRequestClaims(controlDbPath, requestIds, "architect-runtime")).toThrow(
			"reject renewal",
		);

		const reader = createSqliteDatabase(controlDbPath);
		try {
			const row = reader.prepare("SELECT claimed_at FROM architect_requests WHERE id = ?").get(requestIds[0]) as {
				claimed_at: string;
			};
			expect(row.claimed_at).toBe(originalClaimedAt);
		} finally {
			reader.close();
		}
	});

	it("rejects renewal when a claimed Architect request is no longer owned", () => {
		const requestIds = ["first", "second"].map((body) =>
			postArchitectRequest(controlDbPath, { senderSessionId: "main-session", body }),
		);
		claimPendingArchitectRequests(controlDbPath, "architect-runtime", 2);
		const db = createSqliteDatabase(controlDbPath);
		const originalClaimedAt = "2020-01-01T00:00:00.000Z";
		try {
			db.prepare("UPDATE architect_requests SET claimed_at = ? WHERE claim_token = ?").run(
				originalClaimedAt,
				"architect-runtime",
			);
			db.prepare("UPDATE architect_requests SET claim_token = ? WHERE id = ?").run("other-runtime", requestIds[1]);
		} finally {
			db.close();
		}

		expect(() => renewArchitectRequestClaims(controlDbPath, requestIds, "architect-runtime")).toThrow(
			`Architect request claim lost: ${requestIds[1]}`,
		);
		const row = createSqliteDatabase(controlDbPath);
		try {
			const first = row.prepare("SELECT claimed_at FROM architect_requests WHERE id = ?").get(requestIds[0]) as {
				claimed_at: string;
			};
			expect(first.claimed_at).toBe(originalClaimedAt);
		} finally {
			row.close();
		}
	});

	it("ignores renewal for a request completed during processing", () => {
		const requestId = postArchitectRequest(controlDbPath, { senderSessionId: "main-session", body: "complete me" });
		claimPendingArchitectRequests(controlDbPath, "architect-runtime");
		completeArchitectRequest(controlDbPath, requestId, "architect-runtime");
		expect(() => renewArchitectRequestClaims(controlDbPath, [requestId], "architect-runtime")).not.toThrow();
	});

	it("rejects mailbox ID reuse without overwriting the existing message", () => {
		const sessionPath = "/sessions/supervisor.jsonl";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_2", {
			body: "original",
			fromAgentId: "agent_3",
			id: "message_2",
			kind: "system",
			status: "delivered",
			toAgentId: "main",
		});

		expect(() =>
			upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_2", {
				body: "replacement",
				fromAgentId: "agent_13",
				id: "message_2",
				kind: "system",
				status: "pending",
				toAgentId: "main",
			}),
		).toThrow("Mailbox message ID collision");
		const db = createSqliteDatabase(controlDbPath);
		try {
			const row = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, "message_2") as { data: string };
			expect(JSON.parse(row.data)).toMatchObject({ body: "original", fromAgentId: "agent_3", status: "delivered" });
		} finally {
			db.close();
		}
	});

	it("rejects conflicting duplicate runtime mailbox enqueues", () => {
		const input = {
			kind: "message" as const,
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId: "conflict", sessionPath: "/sessions/conflict.jsonl" },
		};
		upsertMultiAgentMailboxMessage(controlDbPath, input.storeRef.sessionPath, input.storeRef.messageId, {
			body: "conflict",
			fromAgentId: "main",
			id: input.storeRef.messageId,
			kind: "message",
			status: "pending",
			toAgentId: "main",
		});
		enqueueRuntimeMailboxMessage(controlDbPath, input);

		expect(() =>
			enqueueRuntimeMailboxMessage(controlDbPath, {
				...input,
				recipient: { agentId: null, sessionId: "other-recipient" },
			}),
		).toThrow("conflicts with canonical mailbox row");
	});

	it("delivers the claimed canonical mailbox row atomically", () => {
		const sessionPath = "/sessions/atomic-delivery.jsonl";
		const messageId = "atomic-delivery";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "atomic delivery",
			fromAgentId: "main",
			id: messageId,
			kind: "message",
			status: "pending",
			toAgentId: "main",
		});
		const id = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId, sessionPath },
		});
		claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "recipient-session" });
		expect(deliverRuntimeMailboxMessage(controlDbPath, id)).toBe(true);
		expect(readRuntimeMailboxMessage(controlDbPath, id)?.status).toBe("delivered");
		const db = createSqliteDatabase(controlDbPath);
		try {
			const row = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, messageId) as { data: string };
			expect(JSON.parse(row.data).status).toBe("delivered");
		} finally {
			db.close();
		}
	});

	it("rolls back canonical delivery when its row update fails", () => {
		const sessionPath = "/sessions/atomic-rollback.jsonl";
		const messageId = "atomic-rollback";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "rollback",
			fromAgentId: "main",
			id: messageId,
			kind: "message",
			status: "pending",
			toAgentId: "main",
		});
		const id = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId, sessionPath },
		});
		claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "recipient-session" });
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TRIGGER reject_canonical_delivery
				BEFORE UPDATE OF data ON multi_agent_mailbox_messages
				WHEN OLD.rowid = ${id} AND json_extract(NEW.data, '$.status') = 'delivered'
				BEGIN
					SELECT RAISE(ABORT, 'reject canonical delivery');
				END
			`);
		} finally {
			db.close();
		}

		expect(() => deliverRuntimeMailboxMessage(controlDbPath, id)).toThrow("reject canonical delivery");
		expect(readRuntimeMailboxMessage(controlDbPath, id)?.status).toBe("claimed");
		const reader = createSqliteDatabase(controlDbPath);
		try {
			const row = reader
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, messageId) as { data: string };
			expect(JSON.parse(row.data).status).toBe("claimed");
		} finally {
			reader.close();
		}
	});

	it("does not consume malformed durable mailbox rows", () => {
		const sessionPath = "/sessions/malformed.jsonl";
		const messageId = "malformed";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "malformed",
			fromAgentId: "main",
			id: messageId,
			kind: "message",
			status: "pending",
			toAgentId: "main",
		});
		const id = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId, sessionPath },
		});
		claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "recipient-session" });
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare("UPDATE multi_agent_mailbox_messages SET data = ? WHERE session_path = ? AND message_id = ?").run(
				"not-json",
				sessionPath,
				messageId,
			);
		} finally {
			db.close();
		}

		expect(() => consumeRuntimeMailboxMessage(controlDbPath, id)).toThrow(/Invalid persisted JSON/);
		expect(() => readRuntimeMailboxMessage(controlDbPath, id)).toThrow(/Invalid persisted JSON/);
	});

	it("consumes an already-resolved mailbox row by transport ID", () => {
		const sessionPath = "/sessions/consumed.jsonl";
		const messageId = "already-delivered";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "already delivered",
			fromAgentId: "main",
			id: messageId,
			kind: "message",
			status: "delivered",
			toAgentId: "main",
		});
		const id = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId, sessionPath },
		});
		expect(consumeRuntimeMailboxMessage(controlDbPath, id)).toBe(true);
		expect(readRuntimeMailboxMessage(controlDbPath, id)?.status).toBe("delivered");
	});

	it("rejects runtime mailbox references without a durable store message", () => {
		expect(() =>
			enqueueRuntimeMailboxMessage(controlDbPath, {
				kind: "message",
				recipient: { agentId: null, sessionId: "recipient-session" },
				sender: { agentId: null, sessionId: "sender-session" },
				storeRef: { messageId: "missing", sessionPath: "/sessions/missing.jsonl" },
			}),
		).toThrow("Runtime mailbox store reference does not exist");
	});

	it("rejects non-string persisted file reference labels", () => {
		readMultiAgentState(controlDbPath, "/sessions/invalid-label.jsonl");
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(
				"/sessions/invalid-label.jsonl",
				"invalid-label",
				JSON.stringify({
					body: "invalid",
					fileRefs: [{ path: "/tmp/output.log", label: 42 }],
				}),
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, "/sessions/invalid-label.jsonl")).toThrow(/label.*string/i);
	});

	it("initializes the lifecycle repository under standalone Bun", () => {
		const moduleUrl = pathToFileURL(join(process.cwd(), "src/core/session-control-db.ts")).href;
		const scriptPath = join(tempDir, "bun-lifecycle-repository.ts");
		writeFileSync(
			scriptPath,
			`import { bootstrapMultiAgentAgent, readMultiAgentState } from ${JSON.stringify(moduleUrl)};
const controlDbPath = process.argv[2];
const sessionPath = "/sessions/bun-runtime.jsonl";
bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent-1", { id: "agent-1", lifecycle: "running", revision: 1 });
const state = readMultiAgentState(controlDbPath, sessionPath);
if (state?.agents.length !== 1) throw new Error("Bun lifecycle repository did not persist the agent");
`,
		);

		const result = spawnSync("bun", [scriptPath, controlDbPath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("rejects a control database created by a newer lifecycle protocol", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 999");
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, "/sessions/newer-protocol.jsonl")).toThrow(
			/unsupported control database schema version 999/i,
		);
	});

	it("creates the exact process ownership schema", () => {
		readMultiAgentState(controlDbPath, "/sessions/dispatch-schema.jsonl");
		const db = createSqliteDatabase(controlDbPath);
		try {
			const columns = db.prepare("PRAGMA table_info(multi_agent_runtime_owners)").all() as Array<{
				name: string;
				notnull: number;
			}>;
			expect(columns.map((column) => column.name)).toEqual([
				"session_path",
				"agent_id",
				"process_identity",
				"owner_session_id",
				"owner_agent_id",
			]);
		} finally {
			db.close();
		}
	});

	it("creates a child and its runtime ownership atomically", () => {
		const sessionPath = "/sessions/child-ownership.jsonl";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent-parent", {
			createdAt: "2026-07-11T00:00:00.000Z",
			cwd: "/repo",
			displayName: "Parent",
			agentType: "main",
			id: "agent-parent",
			lifecycle: "running",
			parentId: undefined,
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const created = createMultiAgentChildWithRuntimeOwnership(controlDbPath, {
			agentId: "agent-child",
			agent: {
				createdAt: "2026-07-11T00:00:00.000Z",
				cwd: "/repo",
				displayName: "Child",
				agentType: "implement",
				id: "agent-child",
				lifecycle: "running",
				parentId: "agent-parent",
				permission: { narrowed: true, policy: "on-request" },
				revision: 1,
				updatedAt: "2026-07-11T00:00:00.000Z",
			},
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: testProcessIdentity("runtime-child"),
			sessionPath,
		});
		expect(created).toMatchObject({
			agent: { id: "agent-child", lifecycle: "running", parentId: "agent-parent", revision: 1 },
			ok: true,
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: "agent-parent" },
			{ id: "agent-child", parentId: "agent-parent" },
		]);
		expect(readMultiAgentRuntimeOwnership(controlDbPath, sessionPath, "agent-child")).toMatchObject({});
	});

	it("serializes lifecycle mutation under the complete process ownership predicate", async () => {
		const sessionPath = "/sessions/lifecycle-cas.jsonl";
		const agentId = "agent-cas";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			createdAt: "2026-07-11T00:00:00.000Z",
			cwd: "/repo",
			displayName: "CAS agent",
			agentType: "test",
			id: agentId,
			lifecycle: "running",
			parentId: undefined,
			permission: { narrowed: true, policy: "on-request" },
			revision: 0,
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: testProcessIdentity("runtime-cas"),
			sessionPath,
		});
		const command = {
			agentId,
			owner: { agentId: null, sessionId: "supervisor" },
			requestedLifecycle: "waiting_for_input" as const,
			processIdentity: testProcessIdentity("runtime-cas"),
			sessionPath,
			updatedAt: "2026-07-11T00:01:00.000Z",
		};
		const mismatchedCommands = [
			{ ...command, processIdentity: testProcessIdentity("wrong-runtime") },
			{ ...command, owner: { agentId: null, sessionId: "wrong-owner" } },
		];
		for (const mismatched of mismatchedCommands) {
			expect(commitMultiAgentLifecycleMutation(controlDbPath, mismatched)).toEqual({
				error: "mutation_mismatch",
				ok: false,
			});
			expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
				{ lifecycle: "running", revision: 0 },
			]);
		}
		const moduleUrl = pathToFileURL(join(process.cwd(), "src/core/session-control-db.ts")).href;
		const workerSource = `
			import { parentPort, workerData } from "node:worker_threads";
			import { commitMultiAgentLifecycleMutation } from ${JSON.stringify(moduleUrl)};
			parentPort?.postMessage(commitMultiAgentLifecycleMutation(workerData.controlDbPath, workerData.command));
		`;
		const results = await Promise.all(
			Array.from(
				{ length: 2 },
				() =>
					new Promise<unknown>((resolve, reject) => {
						const worker = new Worker(workerSource, {
							eval: true,
							execArgv: ["--experimental-strip-types"],
							workerData: { command, controlDbPath },
						});
						worker.on("message", resolve);
						worker.on("error", reject);
					}),
			),
		);
		expect(results.filter((result) => (result as { ok: boolean }).ok)).toHaveLength(2);
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ lifecycle: "waiting_for_input", revision: 1 },
		]);
	});

	it("commits steering lifecycle and durable mailbox payload atomically", () => {
		const sessionPath = "/sessions/steering.jsonl";
		const agentId = "agent-steer";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			id: agentId,
			lifecycle: "running",
			origin: "spawned",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 3,
			transcript: { path: "/sessions/steering-child.jsonl", sessionId: "steering-child" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const steeringProcessIdentity = CURRENT_PROCESS_IDENTITY;
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: steeringProcessIdentity,
			sessionPath,
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "supervisor" },
			process.pid,
			sessionPath,
		);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId, sessionId: "steering-child" },
			steeringProcessIdentity.pid,
			undefined,
			{ runtimeInstanceId: JSON.stringify(steeringProcessIdentity) },
		);
		const message = {
			body: "Continue",
			createdAt: "2026-07-11T00:01:00.000Z",
			fromAgentId: "supervisor",
			id: "message_1",
			kind: "steer" as const,
			status: "pending" as const,
			toAgentId: agentId,
			updatedAt: "2026-07-11T00:01:00.000Z",
		};
		const committed = commitMultiAgentSteeringMutation(controlDbPath, {
			agentId,
			body: message.body,
			fromAgentId: message.fromAgentId,
			owner: { agentId: null, sessionId: "supervisor" },
			recipient: { agentId, sessionId: "steering-child" },
			requestedLifecycle: "steering_pending",
			processIdentity: steeringProcessIdentity,
			sessionPath,
			updatedAt: message.updatedAt,
		});

		expect(committed).toMatchObject({
			agent: { lifecycle: "steering_pending", revision: 4 },
			message: { id: "message_1" },
			ok: true,
		});
		expect(
			commitMultiAgentSteeringMutation(controlDbPath, {
				agentId,
				body: "Invalid duplicate steering",
				fromAgentId: "supervisor",
				owner: { agentId: null, sessionId: "supervisor" },
				processIdentity: steeringProcessIdentity,
				recipient: { agentId, sessionId: "steering-child" },
				requestedLifecycle: "completed",
				sessionPath,
				updatedAt: "2026-07-11T00:01:30.000Z",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.counters.nextMessageNumber).toBe(2);
		expect(
			commitMultiAgentLifecycleMutation(controlDbPath, {
				agentId,
				owner: { agentId: null, sessionId: "supervisor" },
				processIdentity: steeringProcessIdentity,
				requestedLifecycle: "waiting_for_input",
				sessionPath,
				updatedAt: "2026-07-11T00:02:00.000Z",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		expect(
			commitMultiAgentTerminalMutation(controlDbPath, {
				agentId,
				eventKind: "completed",
				owner: { agentId: null, sessionId: "supervisor" },
				processIdentity: steeringProcessIdentity,
				sessionPath,
				terminalLifecycle: "completed",
				updatedAt: "2026-07-11T00:02:00.000Z",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		expect(readMultiAgentState(controlDbPath, sessionPath)).toMatchObject({
			agents: [{ id: agentId, lifecycle: "steering_pending", revision: 4 }],
			counters: { nextMessageNumber: 2 },
			mailboxMessages: [{ id: "message_1", status: "pending" }],
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.mailboxMessages[0]).toMatchObject({
			recipientAgentId: agentId,
			recipientSessionId: "steering-child",
			senderAgentId: null,
			senderSessionId: "supervisor",
		});
		expect(
			commitMultiAgentLifecycleMutation(controlDbPath, {
				agentId,
				owner: { agentId: null, sessionId: "supervisor" },
				processIdentity: steeringProcessIdentity,
				requestedLifecycle: "running",
				sessionPath,
				updatedAt: "2026-07-11T00:03:00.000Z",
			}),
		).toMatchObject({ ok: true, agent: { lifecycle: "running", revision: 5 } });
		expect(
			commitMultiAgentLifecycleMutation(controlDbPath, {
				agentId,
				owner: { agentId: null, sessionId: "supervisor" },
				processIdentity: steeringProcessIdentity,
				requestedLifecycle: "waiting_for_input",
				sessionPath,
				updatedAt: "2026-07-11T00:04:00.000Z",
			}),
		).toMatchObject({ ok: true, agent: { lifecycle: "waiting_for_input", revision: 6 } });
		const rejectedMessages = [
			{
				message: { ...message, id: "message_2", updatedAt: "2026-07-11T00:05:00.000Z" },
				recipient: { agentId, sessionId: "wrong-child-session" },
			},
			{
				message: { ...message, id: "message_3", updatedAt: "2026-07-11T00:06:00.000Z" },
				recipient: { agentId: "wrong-agent", sessionId: "steering-child" },
			},
			{
				message: {
					...message,
					fromAgentId: "wrong-sender",
					id: "message_4",
					updatedAt: "2026-07-11T00:06:30.000Z",
				},
				recipient: { agentId, sessionId: "steering-child" },
			},
		];
		for (const rejected of rejectedMessages) {
			expect(
				commitMultiAgentSteeringMutation(controlDbPath, {
					agentId,
					body: rejected.message.body,
					fromAgentId: rejected.message.fromAgentId,
					owner: { agentId: null, sessionId: "supervisor" },
					recipient: rejected.recipient,
					requestedLifecycle: "steering_pending",
					processIdentity: steeringProcessIdentity,
					sessionPath,
					updatedAt: rejected.message.updatedAt,
				}),
			).toEqual({ ok: false, error: "mutation_mismatch" });
		}
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId, sessionId: "steering-child" },
			steeringProcessIdentity.pid,
			undefined,
			{
				runtimeInstanceId: JSON.stringify({
					pid: steeringProcessIdentity.pid,
					startTimeTicks: steeringProcessIdentity.startTimeTicks + 1,
				}),
			},
		);
		expect(
			commitMultiAgentSteeringMutation(controlDbPath, {
				agentId,
				body: message.body,
				fromAgentId: message.fromAgentId,
				owner: { agentId: null, sessionId: "supervisor" },
				recipient: { agentId, sessionId: "steering-child" },
				requestedLifecycle: "steering_pending",
				processIdentity: steeringProcessIdentity,
				sessionPath,
				updatedAt: "2026-07-11T00:06:45.000Z",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId, sessionId: "steering-child" },
			steeringProcessIdentity.pid + 1,
			undefined,
			{ runtimeInstanceId: JSON.stringify(steeringProcessIdentity) },
		);
		expect(
			commitMultiAgentSteeringMutation(controlDbPath, {
				agentId,
				body: message.body,
				fromAgentId: message.fromAgentId,
				owner: { agentId: null, sessionId: "supervisor" },
				recipient: { agentId, sessionId: "steering-child" },
				requestedLifecycle: "steering_pending",
				processIdentity: steeringProcessIdentity,
				sessionPath,
				updatedAt: "2026-07-11T00:07:00.000Z",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
		expect(readMultiAgentState(controlDbPath, sessionPath)).toMatchObject({
			agents: [{ lifecycle: "waiting_for_input", revision: 6 }],
			counters: { nextMessageNumber: 2 },
			mailboxMessages: [{ id: "message_1" }],
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId, sessionId: "steering-child" },
			steeringProcessIdentity.pid,
			undefined,
			{ runtimeInstanceId: JSON.stringify(steeringProcessIdentity) },
		);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "supervisor" },
			process.pid,
			sessionPath,
			{
				reconcileRuntimeReplacement: false,
				runtimeInstanceId: "stale-sender",
			},
		);
		expect(
			commitMultiAgentSteeringMutation(controlDbPath, {
				agentId,
				body: message.body,
				fromAgentId: message.fromAgentId,
				owner: { agentId: null, sessionId: "supervisor" },
				recipient: { agentId, sessionId: "steering-child" },
				requestedLifecycle: "steering_pending",
				processIdentity: steeringProcessIdentity,
				sessionPath,
				updatedAt: "2026-07-11T00:08:00.000Z",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "supervisor" },
			process.pid,
			sessionPath,
		);
		const lateSteering = commitMultiAgentSteeringMutation(controlDbPath, {
			agentId,
			body: "Wake after idle",
			fromAgentId: message.fromAgentId,
			owner: { agentId: null, sessionId: "supervisor" },
			recipient: { agentId, sessionId: "steering-child" },
			requestedLifecycle: "steering_pending",
			processIdentity: steeringProcessIdentity,
			sessionPath,
			updatedAt: "2026-07-11T00:09:00.000Z",
		});
		expect(lateSteering).toMatchObject({
			agent: { lifecycle: "steering_pending", revision: 7 },
			message: { id: "message_2" },
			ok: true,
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.counters.nextMessageNumber).toBe(3);
	});

	it("rejects steering to a dead recipient without advancing its counter", () => {
		const sessionPath = "/sessions/dead-steering.jsonl";
		const agentId = "agent-dead-steer";
		const deadIdentity = testProcessIdentity("dead-steering-runtime");
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			createdAt: "2026-07-11T00:00:00.000Z",
			displayName: "Dead steering target",
			agentType: "test",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			transcript: { path: "/sessions/dead-child.jsonl", sessionId: "dead-child" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: deadIdentity,
			sessionPath,
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "supervisor" },
			process.pid,
			sessionPath,
		);
		registerRuntimeMailboxListener(controlDbPath, { agentId, sessionId: "dead-child" }, deadIdentity.pid, undefined, {
			runtimeInstanceId: JSON.stringify(deadIdentity),
		});

		expect(
			commitMultiAgentSteeringMutation(controlDbPath, {
				agentId,
				body: "Cannot deliver",
				fromAgentId: "supervisor",
				owner: { agentId: null, sessionId: "supervisor" },
				processIdentity: deadIdentity,
				recipient: { agentId, sessionId: "dead-child" },
				requestedLifecycle: "steering_pending",
				sessionPath,
				updatedAt: "2026-07-11T00:01:00.000Z",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
		expect(readMultiAgentState(controlDbPath, sessionPath)).toMatchObject({
			agents: [{ lifecycle: "running", revision: 1 }],
			counters: { nextMessageNumber: 1 },
			mailboxMessages: [],
		});
	});

	it("commits terminal lifecycle state, immutable event, and outbox atomically", () => {
		const sessionPath = "/sessions/terminal-commit.jsonl";
		const agentId = "agent-1";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			createdAt: "2026-07-11T00:00:00.000Z",
			currentActivity: { phase: "thinking", startedAt: "2026-07-11T00:00:00.000Z" },
			cwd: "/repo",
			displayName: "Terminal agent",
			agentType: "test",
			id: agentId,
			lifecycle: "running",
			parentId: undefined,
			permission: { narrowed: true, policy: "on-request" },
			revision: 4,
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: testProcessIdentity("runtime-terminal"),
			sessionPath,
		});
		expect(() =>
			bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
				createdAt: "2026-07-11T00:00:00.000Z",
				cwd: "/repo",
				displayName: "Illegal rewrite",
				agentType: "test",
				id: agentId,
				lifecycle: "completed",
				parentId: undefined,
				permission: { narrowed: true, policy: "on-request" },
				revision: 99,
				updatedAt: "2026-07-11T00:00:30.000Z",
			}),
		).toThrow("Generic agent upsert cannot mutate process-owned lifecycle row");
		const mutation = {
			agentId,
			eventKind: "completed",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: testProcessIdentity("runtime-terminal"),
			sessionPath,
			terminalLifecycle: "completed" as const,
			updatedAt: "2026-07-11T00:01:00.000Z",
		};
		const committed = commitMultiAgentTerminalMutation(controlDbPath, mutation);
		expect(committed).toMatchObject({ ok: true, terminalRevision: 5 });
		expect(commitMultiAgentTerminalMutation(controlDbPath, mutation)).toEqual(committed);

		expect(
			claimMultiAgentTerminalOutbox(controlDbPath, "wrong-session", mutation.updatedAt, {
				sessionPath: `${sessionPath}.other`,
			}),
		).toBeUndefined();
		const claimed = claimMultiAgentTerminalOutbox(controlDbPath, "delivery-a", mutation.updatedAt, { sessionPath });
		expect(claimed).toMatchObject({ agentId, attemptCount: 1, eventKind: "completed", status: "claimed" });
		expect(claimMultiAgentTerminalOutbox(controlDbPath, "delivery-b", mutation.updatedAt)).toBeUndefined();
		expect(failMultiAgentTerminalOutbox(controlDbPath, claimed!, "temporary", "2026-07-11T00:02:00.000Z")).toBe(true);
		const retried = claimMultiAgentTerminalOutbox(controlDbPath, "delivery-b", "2026-07-11T00:03:00.000Z");
		expect(retried).toMatchObject({ attemptCount: 2, claimId: "delivery-b", status: "claimed" });
		expect(deliverMultiAgentTerminalOutbox(controlDbPath, retried!, "2026-07-11T00:04:00.000Z")).toBe(true);

		const db = createSqliteDatabase(controlDbPath);
		try {
			const agent = JSON.parse(
				(
					db
						.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
						.get(sessionPath, agentId) as { data: string }
				).data,
			) as Record<string, unknown>;
			expect(agent).toMatchObject({ lifecycle: "completed", revision: 5 });
			expect(agent).not.toHaveProperty("currentActivity");
			expect(db.prepare("SELECT COUNT(*) AS count FROM multi_agent_terminal_outbox").get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("recovers stale terminal outbox claims, poisons exhausted retries, and cleans retained rows", () => {
		const sessionPath = "/sessions/outbox-recovery.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`INSERT INTO multi_agent_terminal_outbox
				 (session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
				 VALUES (?, 'agent-1', 2, 'failed', 'pending', 0, ?)`,
			).run(sessionPath, "2026-07-11T00:00:00.000Z");
		} finally {
			db.close();
		}

		const first = claimMultiAgentTerminalOutbox(controlDbPath, "worker-a", "2026-07-11T00:01:00.000Z", {
			maxAttempts: 2,
			sessionPath,
		});
		expect(first).toMatchObject({ attemptCount: 1, claimId: "worker-a" });
		const recovered = claimMultiAgentTerminalOutbox(controlDbPath, "worker-b", "2026-07-11T00:02:00.000Z", {
			maxAttempts: 2,
			sessionPath,
			staleClaimBefore: "2026-07-11T00:01:30.000Z",
		});
		expect(recovered).toMatchObject({ attemptCount: 2, claimId: "worker-b" });
		expect(
			failMultiAgentTerminalOutbox(controlDbPath, recovered!, "permanent", "2026-07-11T00:03:00.000Z", {
				maxAttempts: 2,
			}),
		).toBe(true);
		expect(claimMultiAgentTerminalOutbox(controlDbPath, "worker-c", "2026-07-11T00:04:00.000Z")).toBeUndefined();
		expect(cleanupMultiAgentTerminalOutbox(controlDbPath, "2026-07-11T00:04:00.000Z")).toBe(1);
	});

	it("rejects child activity from a stale runtime owner", () => {
		const sessionPath = "/sessions/activity-owner.jsonl";
		const agentId = "agent-activity";
		const firstIdentity = testProcessIdentity("activity-runtime-1");
		const secondIdentity = testProcessIdentity("activity-runtime-2");
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			agentType: "test",
			createdAt: "2026-07-11T00:00:00.000Z",
			cwd: "/repo",
			displayName: "Activity agent",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: firstIdentity,
			sessionPath,
		});

		expect(
			updateMultiAgentAgentCurrentActivity(
				controlDbPath,
				sessionPath,
				agentId,
				{ phase: "thinking", startedAt: "2026-07-11T00:00:01.000Z" },
				"2026-07-11T00:00:01.000Z",
				{ ownerSessionId: "supervisor", processIdentity: firstIdentity },
			),
		).toMatchObject({ currentActivity: { phase: "thinking" } });
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T00:00:02.000Z",
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity: secondIdentity,
			sessionPath,
		});

		expect(
			updateMultiAgentAgentCurrentActivity(
				controlDbPath,
				sessionPath,
				agentId,
				{ phase: "tool", startedAt: "2026-07-11T00:00:03.000Z", toolCallId: "stale", toolName: "edit" },
				"2026-07-11T00:00:03.000Z",
				{ ownerSessionId: "supervisor", processIdentity: firstIdentity },
			),
		).toBeUndefined();
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents[0]).toMatchObject({
			currentActivity: {
				phase: "thinking",
				startedAt: "2026-07-11T00:00:01.000Z",
			},
		});
	});

	it("updates transcript metadata without overwriting a newer lifecycle revision", () => {
		const sessionPath = "/sessions/transcript-merge.jsonl";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent-1", {
			agentType: "test",
			createdAt: "2026-07-11T00:00:00.000Z",
			cwd: "/repo",
			displayName: "Transcript agent",
			id: "agent-1",
			lifecycle: "completed",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 5,
			updatedAt: "2026-07-11T00:01:00.000Z",
		});

		const updated = updateMultiAgentAgentTranscript(
			controlDbPath,
			sessionPath,
			"agent-1",
			{ path: "/sessions/child.jsonl", sessionId: "child-session" },
			"2026-07-11T00:02:00.000Z",
		);

		expect(updated).toMatchObject({
			lifecycle: "completed",
			revision: 5,
			transcript: { path: "/sessions/child.jsonl", sessionId: "child-session" },
		});
		expect(
			updateMultiAgentAgentCurrentActivity(
				controlDbPath,
				sessionPath,
				"agent-1",
				{ phase: "thinking", startedAt: "2026-07-11T00:02:30.000Z" },
				"2026-07-11T00:02:30.000Z",
				{ ownerSessionId: "supervisor", processIdentity: testProcessIdentity("missing-activity-owner") },
			),
		).toBeUndefined();
		expect(
			updateMultiAgentAgentActivity(
				controlDbPath,
				sessionPath,
				"agent-1",
				{ description: "Received mailbox message" },
				"2026-07-11T00:03:00.000Z",
			),
		).toMatchObject({
			lastActivity: { description: "Received mailbox message" },
			lifecycle: "completed",
			revision: 5,
		});
		expect(
			updateMultiAgentAgentSlot(
				controlDbPath,
				sessionPath,
				"agent-1",
				{ index: 3, pinned: true },
				"2026-07-11T00:04:00.000Z",
			),
		).toMatchObject({ lifecycle: "completed", revision: 5, slot: { index: 3, pinned: true } });
	});

	it("finalizes a detached job from its exact terminal input", () => {
		const sessionPath = "/sessions/detached-finalize.jsonl";
		const agentId = "job-1";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			agentType: "background",
			createdAt: "2026-07-11T21:00:00.000Z",
			currentActivity: { phase: "thinking", startedAt: "2026-07-11T21:00:00.000Z" },
			cwd: "/repo",
			detached: true,
			displayName: "Detached job",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 4,
			updatedAt: "2026-07-11T21:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T21:00:00.000Z",
			owner: { agentId: null, sessionId: "runner" },
			processIdentity: testProcessIdentity("runtime-1"),
			sessionPath,
		});
		const artifacts = createDetachedJobArtifacts(mkdtempSync(join(tmpdir(), "pi-detached-finalize-")), agentId);
		writeFileSync(artifacts.outputPath, "runner output", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			artifacts,
			{
				jobId: agentId,
				owner: { agentId: null, sessionId: "runner" },
				outputLabel: "Bash output",
				processIdentity: testProcessIdentity("runtime-1"),
			},
			{ exitCode: 0, kind: "completed", summary: "done" },
			"2026-07-11T22:00:00.000Z",
			3_600_000,
		);

		const finalized = finalizeDetachedJob(controlDbPath, { sessionPath, terminal });
		expect(finalized).toMatchObject({
			ok: true,
			terminalAgent: { id: agentId, lifecycle: "completed", revision: 5 },
			terminalRevision: 5,
		});
		expect(finalizeDetachedJob(controlDbPath, { sessionPath, terminal })).toEqual(finalized);
		expect(finalized.ok ? finalized.terminalAgent.currentActivity : "missing").toBeUndefined();
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{
				id: agentId,
				lifecycle: "completed",
				result: { durationMs: 3_600_000, fileRefs: [{ path: terminal.output.path }], summary: "done" },
				revision: 5,
			},
		]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				kind: "system",
				recipient: { agentId: null, sessionId: "runner" },
				sender: { agentId, sessionId: "runner" },
				status: "pending",
				storeRef: {
					messageId: `terminal:${agentId}:5:detached_job_completed`,
					sessionPath,
				},
			},
		]);
		expect(
			forceRuntimeOwnership(controlDbPath, {
				agentId,
				nowIso: "2026-07-11T23:01:00.000Z",
				owner: { agentId: null, sessionId: "runner-2" },
				processIdentity: testProcessIdentity("runtime-2"),
				sessionPath,
			}),
		).toMatchObject({ ok: true });
		expect(finalizeDetachedJob(controlDbPath, { sessionPath, terminal })).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			expect(db.prepare("SELECT COUNT(*) AS count FROM multi_agent_terminal_outbox").get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("finalizes an attended job without a supervisor mailbox notification", () => {
		const sessionPath = "/sessions/attended-finalize.jsonl";
		const agentId = "attended-job";
		const owner = { agentId: null, sessionId: "runner" };
		const processIdentity = testProcessIdentity("attended-runtime");
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			agentType: "background",
			createdAt: "2026-07-11T21:00:00.000Z",
			cwd: "/repo",
			displayName: "Attended job",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			updatedAt: "2026-07-11T21:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, { agentId, owner, processIdentity, sessionPath });
		const artifacts = createDetachedJobArtifacts(mkdtempSync(join(tmpdir(), "pi-attended-finalize-")), agentId);
		writeFileSync(artifacts.outputPath, "runner output", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			artifacts,
			{ jobId: agentId, outputLabel: "Bash output", owner, processIdentity },
			{ exitCode: 0, kind: "completed", summary: "done in-band" },
			"2026-07-11T22:00:00.000Z",
		);

		expect(finalizeDetachedJob(controlDbPath, { sessionPath, terminal })).toMatchObject({
			ok: true,
			terminalAgent: { id: agentId, lifecycle: "completed", revision: 2 },
		});
		// The waiting tool call consumes the terminal row in-band; no mailbox wakeup.
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
		const db = createSqliteDatabase(controlDbPath);
		try {
			expect(db.prepare("SELECT COUNT(*) AS count FROM multi_agent_terminal_outbox").get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	});

	it("marks an owned job detached exactly once under the full owner predicate", () => {
		const sessionPath = "/sessions/detach-mark.jsonl";
		const agentId = "mark-job";
		const owner = { agentId: null, sessionId: "runner" };
		const processIdentity = testProcessIdentity("mark-runtime");
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			agentType: "background",
			createdAt: "2026-07-11T21:00:00.000Z",
			cwd: "/repo",
			displayName: "Marked job",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			updatedAt: "2026-07-11T21:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, { agentId, owner, processIdentity, sessionPath });

		expect(
			commitMultiAgentDetachMark(controlDbPath, {
				agentId,
				owner: { agentId: null, sessionId: "someone-else" },
				processIdentity,
				sessionPath,
				updatedAt: "2026-07-11T21:30:00.000Z",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });

		const marked = commitMultiAgentDetachMark(controlDbPath, {
			agentId,
			owner,
			processIdentity,
			sessionPath,
			updatedAt: "2026-07-11T21:31:00.000Z",
		});
		expect(marked).toMatchObject({ ok: true, agent: { detached: true, revision: 2 } });

		// Idempotent: a second mark does not bump the revision.
		expect(
			commitMultiAgentDetachMark(controlDbPath, {
				agentId,
				owner,
				processIdentity,
				sessionPath,
				updatedAt: "2026-07-11T21:32:00.000Z",
			}),
		).toMatchObject({ ok: true, agent: { detached: true, revision: 2 } });

		const artifacts = createDetachedJobArtifacts(mkdtempSync(join(tmpdir(), "pi-detach-mark-")), agentId);
		writeFileSync(artifacts.outputPath, "runner output", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			artifacts,
			{ jobId: agentId, outputLabel: "Bash output", owner, processIdentity },
			{ exitCode: 0, kind: "completed", summary: "done detached" },
			"2026-07-11T22:00:00.000Z",
		);
		expect(finalizeDetachedJob(controlDbPath, { sessionPath, terminal })).toMatchObject({
			ok: true,
			terminalAgent: { id: agentId, detached: true, lifecycle: "completed", revision: 3 },
		});
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ storeRef: { messageId: `terminal:${agentId}:3:detached_job_completed`, sessionPath } },
		]);

		// Terminal rows reject further detach marks.
		expect(
			commitMultiAgentDetachMark(controlDbPath, {
				agentId,
				owner,
				processIdentity,
				sessionPath,
				updatedAt: "2026-07-11T23:00:00.000Z",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
	});

	it("finalizes a detached job after its session control data relocates", () => {
		const oldSessionPath = "/sessions/detached-old.jsonl";
		const newSessionPath = "/sessions/detached-new.jsonl";
		const agentId = "relocated-job";
		const owner = { agentId: null, sessionId: "runner" };
		const processIdentity = testProcessIdentity("relocated-runtime");
		bootstrapMultiAgentAgent(controlDbPath, oldSessionPath, agentId, {
			agentType: "background",
			createdAt: "2026-07-11T21:00:00.000Z",
			cwd: "/repo",
			detached: true,
			displayName: "Relocated job",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 1,
			updatedAt: "2026-07-11T21:00:00.000Z",
		});
		forceRuntimeOwnership(controlDbPath, { agentId, owner, processIdentity, sessionPath: oldSessionPath });
		const artifacts = createDetachedJobArtifacts(mkdtempSync(join(tmpdir(), "pi-detached-relocate-")), agentId);
		writeFileSync(artifacts.outputPath, "runner output", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			artifacts,
			{ jobId: agentId, outputLabel: "Bash output", owner, processIdentity },
			{ exitCode: 0, kind: "completed", summary: "done after relocation" },
			"2026-07-11T22:00:00.000Z",
		);

		relocateSessionControlData(controlDbPath, oldSessionPath, newSessionPath);

		expect(readMultiAgentRuntimeOwnership(controlDbPath, newSessionPath, agentId)).toMatchObject({ processIdentity });
		expect(finalizeDetachedJob(controlDbPath, { sessionPath: oldSessionPath, terminal })).toMatchObject({
			ok: true,
			terminalAgent: { id: agentId, lifecycle: "completed", revision: 2 },
		});
		expect(readMultiAgentState(controlDbPath, newSessionPath)?.agents).toMatchObject([
			{ id: agentId, lifecycle: "completed", revision: 2 },
		]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ storeRef: { messageId: `terminal:${agentId}:2:detached_job_completed`, sessionPath: newSessionPath } },
		]);
	});

	it.each(["Bash output", "Pyrun output"])(
		"treats %s exact-owner exit evidence as aborted when cancellation committed first",
		(outputLabel) => {
			const sessionPath = "/sessions/detached-cancel-race.jsonl";
			const agentId = "job-cancel-race";
			const owner = { agentId: null, sessionId: "runner" };
			const processIdentity = testProcessIdentity("cancel-race-runner");
			bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
				agentType: "background",
				createdAt: "2026-07-11T21:00:00.000Z",
				cwd: "/repo",
				displayName: "Detached job",
				id: agentId,
				lifecycle: "running",
				parentId: "main",
				permission: { narrowed: true, policy: "on-request" },
				revision: 4,
				updatedAt: "2026-07-11T21:00:00.000Z",
			});
			expect(
				forceRuntimeOwnership(controlDbPath, {
					agentId,
					nowIso: "2026-07-11T21:00:00.000Z",
					owner,
					processIdentity,
					sessionPath,
				}),
			).toMatchObject({ ok: true });
			expect(
				commitMultiAgentLifecycleMutation(controlDbPath, {
					agentId,
					owner,
					processIdentity,
					requestedLifecycle: "cancelling",
					sessionPath,
					updatedAt: "2026-07-11T21:00:01.000Z",
				}),
			).toMatchObject({ ok: true, agent: { lifecycle: "cancelling", revision: 5 } });
			const artifacts = createDetachedJobArtifacts(mkdtempSync(join(tmpdir(), "pi-detached-cancel-race-")), agentId);
			writeFileSync(artifacts.outputPath, "runner completed before seeing cancel", { mode: 0o600 });
			const terminal = createDetachedJobTerminalInput(
				artifacts,
				{ jobId: agentId, outputLabel, owner, processIdentity },
				{ exitCode: 0, kind: "completed", summary: "natural completion" },
				"2026-07-11T21:00:02.000Z",
			);

			const finalized = finalizeDetachedJob(controlDbPath, { sessionPath, terminal });
			expect(finalized).toMatchObject({
				ok: true,
				terminalAgent: { id: agentId, lifecycle: "aborted", revision: 6 },
				terminalRevision: 6,
			});
			expect(finalizeDetachedJob(controlDbPath, { sessionPath, terminal })).toEqual(finalized);
		},
	);

	it("creates terminal outbox schema without event or cursor tables", () => {
		readMultiAgentState(controlDbPath, "/sessions/terminal-schema.jsonl");
		const db = createSqliteDatabase(controlDbPath);
		try {
			const outboxColumns = db.prepare("PRAGMA table_info(multi_agent_terminal_outbox)").all() as Array<{
				name: string;
			}>;
			expect(outboxColumns.map((column) => column.name)).toEqual([
				"session_path",
				"agent_id",
				"terminal_revision",
				"event_kind",
				"status",
				"claim_id",
				"claimed_at",
				"delivered_at",
				"attempt_count",
				"last_error",
				"updated_at",
			]);
			expect(
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_terminal_events'")
					.get(),
			).toBeUndefined();
			expect(
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_terminal_cursors'")
					.get(),
			).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("blocks live process takeover and permits takeover after exact owner death", () => {
		const sessionPath = "/sessions/process-owner.jsonl";
		const agentId = "agent-owner";
		const liveIdentity = CURRENT_PROCESS_IDENTITY;
		const first = forceRuntimeOwnership(controlDbPath, {
			agentId,
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor-a" },
			processIdentity: liveIdentity,
			sessionPath,
		});
		expect(first).toMatchObject({ ok: true });
		expect(
			forceRuntimeOwnership(controlDbPath, {
				agentId,
				nowIso: "2026-07-11T00:00:01.000Z",
				owner: { agentId: null, sessionId: "supervisor-b" },
				processIdentity: testProcessIdentity("replacement"),
				sessionPath,
			}),
		).toMatchObject({ ok: false, error: "ownership_held" });
	});

	it("terminalizes an agent only after its exact owner process is dead", () => {
		const sessionPath = "/sessions/dead-owner.jsonl";
		const agentId = "agent-dead";
		const processIdentity = testProcessIdentity("dead-owner");
		const created = createMultiAgentChildWithRuntimeOwnership(controlDbPath, {
			agent: {
				agentType: "worker",
				createdAt: "2026-07-11T00:00:00.000Z",
				cwd: "/repo",
				displayName: "Dead child",
				id: agentId,
				lifecycle: "running",
				parentId: "main",
				permission: { narrowed: true, policy: "on-request" },
				revision: 1,
				updatedAt: "2026-07-11T00:00:00.000Z",
				worker: { adapter: "runtime", handleId: "runner-dead", toolCallId: "tool-dead" },
			},
			agentId,
			nowIso: "2026-07-11T00:00:00.000Z",
			owner: { agentId: null, sessionId: "supervisor-a" },
			processIdentity,
			sessionPath,
		});
		expect(created.ok).toBe(true);
		const recoveryInput = {
			expectedOwner: {
				agentId,
				owner: { agentId: null, sessionId: "supervisor-a" },
				processIdentity,
				sessionPath,
			},
			nowIso: "2026-07-11T00:00:01.000Z",
			supervisor: { processIdentity: CURRENT_PROCESS_IDENTITY, sessionId: "supervisor-a" },
		};
		expect(recoverDeadMultiAgentRuntime(controlDbPath, recoveryInput)).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "supervisor-a" },
			CURRENT_PROCESS_IDENTITY.pid,
			sessionPath,
			{ runtimeInstanceId: JSON.stringify(CURRENT_PROCESS_IDENTITY) },
		);
		const recovered = recoverDeadMultiAgentRuntime(controlDbPath, recoveryInput);
		expect(recovered).toMatchObject({
			ok: true,
			agent: { lifecycle: "failed", result: { toolCallId: "tool-dead" }, revision: 2, worker: undefined },
		});
	});

	it("removes renewable lease columns when migrating version ten ownership rows", () => {
		const sessionPath = "/sessions/version-ten-owner.jsonl";
		const agentId = "legacy-active";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			agentType: "worker",
			createdAt: "2026-07-11T00:00:00.000Z",
			cwd: "/repo",
			displayName: "Legacy active",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 2,
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const legacyDb = createSqliteDatabase(controlDbPath);
		try {
			legacyDb.exec(`
				ALTER TABLE multi_agent_runtime_owners ADD COLUMN lease_id TEXT;
				ALTER TABLE multi_agent_runtime_owners ADD COLUMN fencing_epoch INTEGER NOT NULL DEFAULT 0;
				ALTER TABLE multi_agent_runtime_owners ADD COLUMN renewed_at TEXT;
				ALTER TABLE multi_agent_runtime_owners ADD COLUMN expires_at TEXT;
				ALTER TABLE multi_agent_runtime_owners ADD COLUMN recovery_owner_id TEXT;
				PRAGMA user_version = 10;
			`);
			legacyDb
				.prepare(
					`INSERT INTO multi_agent_runtime_owners
					(session_path, agent_id, lease_id, process_identity, owner_session_id, fencing_epoch, expires_at)
				 VALUES (?, ?, 'legacy-lease', 'legacy-runtime', 'supervisor', 4, '2099-01-01T00:00:00.000Z')`,
				)
				.run(sessionPath, agentId);
		} finally {
			legacyDb.close();
		}

		const state = readMultiAgentState(controlDbPath, sessionPath);
		expect(state?.agents).toMatchObject([
			{ id: agentId, lifecycle: "failed", revision: 3, error: { code: "lost_runtime" } },
		]);
		const migratedDb = createSqliteDatabase(controlDbPath);
		try {
			const columns = migratedDb.prepare("PRAGMA table_info(multi_agent_runtime_owners)").all() as Array<{
				name: string;
			}>;
			expect(columns.map((column) => column.name)).toEqual([
				"session_path",
				"agent_id",
				"process_identity",
				"owner_session_id",
				"owner_agent_id",
			]);
			expect((migratedDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
		} finally {
			migratedDb.close();
		}
	});

	it("renames version eleven process ownership storage without losing exact identity", () => {
		const sessionPath = "/sessions/version-eleven-owner.jsonl";
		const agentId = "owned-active";
		const processIdentity = testProcessIdentity("version-eleven-owner");
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, agentId, {
			agentType: "worker",
			createdAt: "2026-07-11T00:00:00.000Z",
			cwd: "/repo",
			displayName: "Owned active",
			id: agentId,
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 2,
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const legacyDb = createSqliteDatabase(controlDbPath);
		try {
			legacyDb
				.prepare(
					`INSERT INTO multi_agent_runtime_owners
					 (session_path, agent_id, process_identity, owner_session_id, owner_agent_id)
					 VALUES (?, ?, ?, 'supervisor', NULL)`,
				)
				.run(sessionPath, agentId, JSON.stringify(processIdentity));
			legacyDb.exec(`
				ALTER TABLE multi_agent_runtime_owners RENAME TO multi_agent_dispatch_leases;
				PRAGMA user_version = 11;
			`);
		} finally {
			legacyDb.close();
		}

		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: agentId, lifecycle: "running", revision: 2 },
		]);
		expect(readMultiAgentRuntimeOwnership(controlDbPath, sessionPath, agentId)).toMatchObject({
			agentId,
			owner: { agentId: null, sessionId: "supervisor" },
			processIdentity,
			sessionPath,
		});
		const migratedDb = createSqliteDatabase(controlDbPath);
		try {
			expect(
				migratedDb
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("multi_agent_dispatch_leases"),
			).toBeUndefined();
			expect((migratedDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
		} finally {
			migratedDb.close();
		}
	});

	it("migrates legacy queued rows and terminalizes orphaned active rows as lost runtime", () => {
		const sessionPath = "/sessions/legacy-lifecycle.jsonl";
		for (const [id, lifecycle] of [
			["queued", "queued"],
			["running", "running"],
		] as const) {
			bootstrapMultiAgentAgent(controlDbPath, sessionPath, id, {
				createdAt: "2026-07-11T00:00:00.000Z",
				cwd: "/repo",
				displayName: id,
				agentType: "test",
				id,
				lifecycle,
				parentId: undefined,
				permission: { narrowed: true, policy: "on-request" },
				revision: 2,
				updatedAt: "2026-07-11T00:00:00.000Z",
			});
		}
		const legacyDb = createSqliteDatabase(controlDbPath);
		try {
			legacyDb.exec("PRAGMA user_version = 7");
		} finally {
			legacyDb.close();
		}

		const state = readMultiAgentState(controlDbPath, sessionPath);
		expect(state?.agents).toMatchObject([
			{ id: "queued", lifecycle: "queued", revision: 2 },
			{ id: "running", lifecycle: "failed", revision: 3, error: { code: "lost_runtime" } },
		]);
		const db = createSqliteDatabase(controlDbPath);
		try {
			expect(
				db
					.prepare(
						"SELECT process_identity FROM multi_agent_runtime_owners WHERE session_path = ? AND agent_id = ?",
					)
					.get(sessionPath, "queued"),
			).toEqual({ process_identity: null });
			expect(db.prepare("SELECT status FROM multi_agent_terminal_outbox WHERE agent_id = 'running'").get()).toEqual({
				status: "pending",
			});
		} finally {
			db.close();
		}
	});

	it("requires detached process-owner quiescence before activating a newer protocol", () => {
		const sessionPath = "/sessions/detached-quiescence.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`INSERT INTO multi_agent_runtime_owners
					(session_path, agent_id, process_identity, owner_session_id, owner_agent_id)
				 VALUES (?, 'agent-live', ?, 'supervisor', NULL)`,
			).run(sessionPath, JSON.stringify(CURRENT_PROCESS_IDENTITY));
			db.exec("PRAGMA user_version = 10");
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, sessionPath)).toThrow(/lifecycle owners are active/);
	});

	it("requires lifecycle writer quiescence before activating a newer protocol", () => {
		const sessionPath = "/sessions/quiescence.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				PRAGMA user_version = 2;
				CREATE TABLE multi_agent_counters (
					session_path TEXT PRIMARY KEY,
					next_agent_number INTEGER NOT NULL,
					next_message_number INTEGER NOT NULL,
					updated_at TEXT NOT NULL
				);
			`);
			db.prepare(
				`INSERT INTO runtime_mailbox_listeners (
					recipient_session_id, recipient_agent_id_key, pid, runtime_instance_id,
					session_path, session_path_asserted_at, updated_at
				) VALUES (?, '', ?, ?, ?, ?, ?)`,
			).run(
				"live-supervisor",
				process.pid,
				"old-runtime",
				sessionPath,
				"2026-07-11T00:00:00.000Z",
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, sessionPath)).toThrow(
			/stop all pi and detached runner processes/i,
		);
		const blockedDb = createSqliteDatabase(controlDbPath);
		try {
			expect(
				blockedDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'multi_agent_counters'").get(),
			).toBeDefined();
		} finally {
			blockedDb.close();
		}

		const offlineDb = createSqliteDatabase(controlDbPath);
		try {
			offlineDb
				.prepare("DELETE FROM runtime_mailbox_listeners WHERE recipient_session_id = ?")
				.run("live-supervisor");
		} finally {
			offlineDb.close();
		}
		expect(readMultiAgentState(controlDbPath, sessionPath)).toBeUndefined();
	});

	it("allows same-PID exec restart to activate a newer lifecycle protocol", () => {
		const sessionPath = "/sessions/self-restart-quiescence.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 2");
			db.prepare(
				`INSERT INTO runtime_mailbox_listeners (
					recipient_session_id, recipient_agent_id_key, pid, runtime_instance_id,
					session_path, session_path_asserted_at, updated_at
				) VALUES (?, '', ?, ?, ?, ?, ?)`,
			).run(
				"restarting-supervisor",
				process.pid,
				"old-runtime",
				sessionPath,
				"2026-07-11T00:00:00.000Z",
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => prepareControlDbForSelfRestart(controlDbPath, process.pid)).not.toThrow();
		expect(readMultiAgentState(controlDbPath, sessionPath)).toBeUndefined();
	});

	it("requires lifecycle writer quiescence for a version-zero database with lifecycle tables", () => {
		const sessionPath = "/sessions/version-zero-quiescence.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 0");
			db.prepare(
				`INSERT INTO runtime_mailbox_listeners (
					recipient_session_id, recipient_agent_id_key, pid, runtime_instance_id,
					session_path, session_path_asserted_at, updated_at
				) VALUES (?, '', ?, ?, ?, ?, ?)`,
			).run(
				"live-supervisor",
				process.pid,
				"old-runtime",
				sessionPath,
				"2026-07-11T00:00:00.000Z",
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, sessionPath)).toThrow(
			/stop all pi and detached runner processes/i,
		);
	});

	it("migrates legacy artifact fields from a pre-upgrade database", () => {
		const sessionPath = "/sessions/legacy-agent.jsonl";
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE multi_agent_agents (
					session_path TEXT NOT NULL,
					agent_id TEXT NOT NULL,
					data TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (session_path, agent_id)
				);
				CREATE TABLE multi_agent_mailbox_messages (
					session_path TEXT NOT NULL,
					message_id TEXT NOT NULL,
					data TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (session_path, message_id)
				);
			`);
			db.prepare(
				`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(
				sessionPath,
				"agent-1",
				'{"id":"agent-1","result":{"artifactIds":["artifact-1"],"artifactRefs":[{"path":"/tmp/legacy.log"}],"fileRefs":[{"path":"/tmp/current.log","label":"Current"}],"summary":"done","__proto__":{"keep":true}}}',
				"2026-07-11T00:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(
				sessionPath,
				"message-1",
				'{"artifactIds":["artifact-2"],"artifactRefs":[{"path":"/tmp/legacy-mailbox.log"}],"body":"legacy mailbox","fileRefs":[{"path":"/tmp/mailbox.log"}],"status":"pending"}',
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		const expectedState = {
			agents: [
				{
					id: "agent-1",
					result: {
						fileRefs: [{ path: "/tmp/current.log", label: "Current" }],
						summary: "done",
					},
				},
			],
			mailboxMessages: [
				{
					body: "legacy mailbox",
					fileRefs: [{ path: "/tmp/mailbox.log" }],
					status: "pending",
				},
			],
		};
		const state = readMultiAgentState(controlDbPath, sessionPath);
		expect(state).toMatchObject(expectedState);
		const agentResult = (state?.agents[0] as { result: Record<string, unknown> }).result;
		expect(Object.hasOwn(agentResult, "__proto__")).toBe(true);
		expect(Reflect.get(agentResult, "__proto__")).toEqual({ keep: true });

		const migratedDb = createSqliteDatabase(controlDbPath);
		let agentUpdatedAt: string;
		try {
			const version = migratedDb.prepare("PRAGMA user_version").get() as { user_version: number };
			expect(version.user_version).toBe(14);
			const triggers = migratedDb
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE type = 'trigger' AND name IN (
						'multi_agent_agents_reject_legacy_artifact_fields_insert',
						'multi_agent_agents_reject_legacy_artifact_fields_update',
						'multi_agent_mailbox_messages_reject_legacy_artifact_fields_insert',
						'multi_agent_mailbox_messages_reject_legacy_artifact_fields_update'
					 ) ORDER BY name`,
				)
				.all() as Array<{ name: string }>;
			expect(triggers.map((trigger) => trigger.name)).toEqual([
				"multi_agent_agents_reject_legacy_artifact_fields_insert",
				"multi_agent_agents_reject_legacy_artifact_fields_update",
				"multi_agent_mailbox_messages_reject_legacy_artifact_fields_insert",
				"multi_agent_mailbox_messages_reject_legacy_artifact_fields_update",
			]);
			const agentRow = migratedDb
				.prepare("SELECT data, updated_at FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, "agent-1") as { data: string; updated_at: string };
			agentUpdatedAt = agentRow.updated_at;
			const mailboxRow = migratedDb
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, "message-1") as { data: string };
			for (const row of [agentRow, mailboxRow]) {
				const visit = (value: unknown): void => {
					if (!value || typeof value !== "object") return;
					if (Array.isArray(value)) {
						for (const item of value) visit(item);
						return;
					}
					for (const [key, nested] of Object.entries(value)) {
						expect(key).not.toMatch(/^artifact(Id|Ref)s$/);
						visit(nested);
					}
				};
				visit(JSON.parse(row.data));
			}
		} finally {
			migratedDb.close();
		}

		expect(readMultiAgentState(controlDbPath, sessionPath)).toMatchObject(expectedState);
		const secondReadDb = createSqliteDatabase(controlDbPath);
		try {
			const agentRow = secondReadDb
				.prepare("SELECT updated_at FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, "agent-1") as { updated_at: string };
			expect(agentRow.updated_at).toBe(agentUpdatedAt);
		} finally {
			secondReadDb.close();
		}

		const alreadyMigratedDb = createSqliteDatabase(controlDbPath);
		try {
			for (const [table, idColumn, id] of [
				["multi_agent_agents", "agent_id", "agent-2"],
				["multi_agent_mailbox_messages", "message_id", "message-2"],
			] as const) {
				expect(() =>
					alreadyMigratedDb
						.prepare(
							`INSERT INTO ${table} (session_path, ${idColumn}, data, updated_at)
							 VALUES (?, ?, ?, ?)`,
						)
						.run(
							sessionPath,
							id,
							JSON.stringify({ nested: [{ result: { artifactIds: ["artifact-3"] } }] }),
							"2026-07-11T00:00:00.000Z",
						),
				).toThrow(/legacy artifact fields/i);
			}
			for (const [table, idColumn, id] of [
				["multi_agent_agents", "agent_id", "agent-1"],
				["multi_agent_mailbox_messages", "message_id", "message-1"],
			] as const) {
				expect(() =>
					alreadyMigratedDb
						.prepare(`UPDATE ${table} SET data = ? WHERE session_path = ? AND ${idColumn} = ?`)
						.run(JSON.stringify({ nested: { artifactRefs: [{ path: "/tmp/legacy.log" }] } }), sessionPath, id),
				).toThrow(/legacy artifact fields/i);
			}
		} finally {
			alreadyMigratedDb.close();
		}
		expect(readMultiAgentState(controlDbPath, sessionPath)).toMatchObject(expectedState);
	});

	it("upgrades an existing version-one database before legacy fields can be written again", () => {
		const sessionPath = "/sessions/version-one.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				DROP TRIGGER multi_agent_agents_reject_legacy_artifact_fields_insert;
				DROP TRIGGER multi_agent_agents_reject_legacy_artifact_fields_update;
				DROP TRIGGER multi_agent_mailbox_messages_reject_legacy_artifact_fields_insert;
				DROP TRIGGER multi_agent_mailbox_messages_reject_legacy_artifact_fields_update;
				PRAGMA user_version = 1;
			`);
			db.prepare(
				`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(
				sessionPath,
				"agent-1",
				JSON.stringify({ nested: { artifactRefs: [{ path: "/tmp/legacy.log" }] }, id: "agent-1" }),
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(readMultiAgentState(controlDbPath, sessionPath)).toMatchObject({
			agents: [{ id: "agent-1" }],
		});
		const upgradedDb = createSqliteDatabase(controlDbPath);
		try {
			const version = upgradedDb.prepare("PRAGMA user_version").get() as { user_version: number };
			expect(version.user_version).toBe(14);
			expect(
				(
					upgradedDb.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ?").get(sessionPath) as {
						data: string;
					}
				).data,
			).not.toContain("artifactRefs");
		} finally {
			upgradedDb.close();
		}
		const blockedDb = createSqliteDatabase(controlDbPath);
		try {
			expect(() =>
				blockedDb
					.prepare(
						`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
						 VALUES (?, ?, ?, ?)`,
					)
					.run(sessionPath, "agent-2", JSON.stringify({ artifactIds: ["blocked"] }), "2026-07-11T00:00:00.000Z"),
			).toThrow(/legacy artifact fields/i);
		} finally {
			blockedDb.close();
		}
	});

	it("preserves malformed persisted JSON for contextual restore validation", () => {
		const sessionPath = "/sessions/malformed.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(sessionPath, "agent-1", '{"artifactIds":[', "2026-07-11T00:00:00.000Z");
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, sessionPath)).toThrow(
			`Invalid persisted JSON at multi_agent_agents:${sessionPath}[0]`,
		);
	});

	it("does not take the migration writer lock after the payload migration version is durable", async () => {
		const sessionPath = "/sessions/already-migrated.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const worker = new Worker(
			`
				import { parentPort, workerData } from "node:worker_threads";
				import { readMultiAgentState } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/core/session-control-db.ts")).href)};
				parentPort?.postMessage("ready");
				parentPort?.once("message", () => {
					try {
						readMultiAgentState(workerData.controlDbPath, workerData.sessionPath);
						parentPort?.postMessage("ok");
					} catch (error) {
						parentPort?.postMessage(String(error));
					}
				});
			`,
			{ eval: true, execArgv: ["--experimental-strip-types"], workerData: { controlDbPath, sessionPath } },
		);
		const holder = createSqliteDatabase(controlDbPath);
		configureSharedSqliteDatabase(holder, { busyTimeoutMs: 100 });
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("migration worker did not load")), 10_000);
				worker.once("message", (message: string) => {
					clearTimeout(timer);
					if (message === "ready") resolve();
					else reject(new Error(`unexpected worker readiness message: ${message}`));
				});
				worker.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
			holder.exec("BEGIN IMMEDIATE");
			worker.postMessage("read");
			const result = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("already-migrated open blocked on a writer transaction")),
					10_000,
				);
				worker.once("message", (message: string) => {
					clearTimeout(timer);
					resolve(message);
				});
				worker.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
			expect(result).toBe("ok");
		} finally {
			await worker.terminate();
			try {
				holder.exec("ROLLBACK");
			} catch {
				// The transaction may already be closed after an early worker failure.
			}
			holder.close();
		}
	});

	it("keeps strict validation after legacy payload migration", () => {
		const sessionPath = "/sessions/legacy-invalid.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 0");
			db.prepare(
				`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(
				sessionPath,
				"message-1",
				JSON.stringify({
					body: "invalid",
					fileRefs: [{ path: "/tmp/output.log", label: 42 }],
				}),
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => readMultiAgentState(controlDbPath, sessionPath)).toThrow(
			`Invalid file reference at multi_agent_mailbox_messages:${sessionPath}[0][0]: label must be a string`,
		);
	});

	it("migrates legacy transport routing into canonical rows and drops the transport table", () => {
		const sessionPath = "/sessions/legacy-transport.jsonl";
		const messageId = "legacy-message";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 13");
			db.exec(`
				CREATE TABLE runtime_mailbox_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id TEXT,
					sender_session_id TEXT,
					sender_agent_id TEXT,
					kind TEXT NOT NULL,
					body TEXT NOT NULL,
					store_session_path TEXT,
					store_message_id TEXT,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					claimed_at TEXT,
					delivered_at TEXT,
					error TEXT
				)
			`);
			db.prepare(
				`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(
				sessionPath,
				messageId,
				JSON.stringify({
					body: "legacy",
					fromAgentId: "agent_1",
					id: messageId,
					kind: "message",
					status: "pending",
					toAgentId: "main",
				}),
				"2026-07-13T00:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO runtime_mailbox_messages
				 (recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind, body,
				  store_session_path, store_message_id, status, created_at, updated_at, claimed_at)
				 VALUES (?, NULL, ?, ?, 'message', '', ?, ?, 'claimed', ?, ?, ?)`,
			).run(
				"recipient-session",
				"sender-session",
				"agent_1",
				sessionPath,
				messageId,
				"2026-07-13T00:00:00.000Z",
				"2026-07-13T00:01:00.000Z",
				"2026-07-13T00:01:00.000Z",
			);
		} finally {
			db.close();
		}

		const [message] = listRuntimeMailboxMessages(controlDbPath);
		expect(message).toMatchObject({
			recipient: { agentId: null, sessionId: "recipient-session" },
			status: "pending",
		});
		const migrated = createSqliteDatabase(controlDbPath);
		try {
			expect(
				migrated
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
					.get(),
			).toBeUndefined();
			expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
		} finally {
			migrated.close();
		}
	});

	it("preserves canonical payloads and delivery while releasing legacy claims during v14 migration", () => {
		const sessionPath = "/sessions/legacy-authority.jsonl";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 13");
			db.exec(`
				CREATE TABLE runtime_mailbox_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id TEXT,
					sender_session_id TEXT,
					sender_agent_id TEXT,
					kind TEXT NOT NULL,
					body TEXT NOT NULL,
					store_session_path TEXT,
					store_message_id TEXT,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					claimed_at TEXT,
					delivered_at TEXT,
					error TEXT
				)
			`);
			const insertCanonical = db.prepare(
				`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, ?, ?)`,
			);
			insertCanonical.run(
				sessionPath,
				"pending-message",
				JSON.stringify({
					body: "pending body",
					correlationId: "correlation-pending",
					fromAgentId: "agent_1",
					id: "pending-message",
					kind: "supervisor_request",
					status: "claimed",
					threadId: "thread-pending",
					toAgentId: "supervisor",
					claimantProcessIdentity: JSON.stringify({ pid: process.pid, startTimeTicks: 1 }),
				}),
				"2026-07-13T00:00:00.000Z",
			);
			insertCanonical.run(
				sessionPath,
				"delivered-message",
				JSON.stringify({
					body: "delivered body",
					correlationId: "correlation-delivered",
					deliveredAt: "2026-07-13T00:02:00.000Z",
					fromAgentId: "agent_2",
					id: "delivered-message",
					kind: "system",
					status: "delivered",
					threadId: "thread-delivered",
					toAgentId: "main",
				}),
				"2026-07-13T00:02:00.000Z",
			);
			const insertRuntime = db.prepare(
				`INSERT INTO runtime_mailbox_messages
				 (recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind, body,
				  store_session_path, store_message_id, status, created_at, updated_at, claimed_at)
				 VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
			);
			insertRuntime.run(
				"recipient-session",
				null,
				"sender-session",
				"agent_1",
				"supervisor_request",
				sessionPath,
				"pending-message",
				"claimed",
				"2026-07-13T00:00:00.000Z",
				"2026-07-13T00:01:00.000Z",
				"2026-07-13T00:01:00.000Z",
			);
			insertRuntime.run(
				"recipient-session",
				null,
				"sender-session",
				"agent_2",
				"system",
				sessionPath,
				"delivered-message",
				"claimed",
				"2026-07-13T00:00:00.000Z",
				"2026-07-13T00:03:00.000Z",
				"2026-07-13T00:03:00.000Z",
			);
		} finally {
			db.close();
		}

		listRuntimeMailboxMessages(controlDbPath);
		const migrated = createSqliteDatabase(controlDbPath);
		try {
			const rows = migrated
				.prepare(
					"SELECT message_id, data FROM multi_agent_mailbox_messages WHERE session_path = ? ORDER BY message_id",
				)
				.all(sessionPath) as Array<{ data: string; message_id: string }>;
			const payloads = Object.fromEntries(rows.map((row) => [row.message_id, JSON.parse(row.data)]));
			expect(payloads["pending-message"]).toMatchObject({
				body: "pending body",
				correlationId: "correlation-pending",
				kind: "supervisor_request",
				status: "pending",
				threadId: "thread-pending",
			});
			expect(payloads["pending-message"]).not.toHaveProperty("claimantProcessIdentity");
			expect(payloads["delivered-message"]).toMatchObject({
				body: "delivered body",
				correlationId: "correlation-delivered",
				deliveredAt: "2026-07-13T00:02:00.000Z",
				kind: "system",
				status: "delivered",
				threadId: "thread-delivered",
			});
			expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
			expect(
				migrated
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
					.get(),
			).toBeUndefined();
		} finally {
			migrated.close();
		}
	});

	it("rolls back legacy transport migration when a referenced canonical payload is malformed", () => {
		const sessionPath = "/sessions/malformed-legacy-transport.jsonl";
		const messageId = "malformed-legacy-message";
		readMultiAgentState(controlDbPath, sessionPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("PRAGMA user_version = 13");
			db.exec(`
				CREATE TABLE runtime_mailbox_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id TEXT,
					sender_session_id TEXT,
					sender_agent_id TEXT,
					kind TEXT NOT NULL,
					body TEXT NOT NULL,
					store_session_path TEXT,
					store_message_id TEXT,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					claimed_at TEXT,
					delivered_at TEXT,
					error TEXT
				)
			`);
			db.prepare(
				`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, 'not-json', ?)`,
			).run(sessionPath, messageId, "2026-07-13T00:00:00.000Z");
			db.prepare(
				`INSERT INTO runtime_mailbox_messages
				 (recipient_session_id, sender_session_id, kind, body, store_session_path, store_message_id,
				  status, created_at, updated_at)
				 VALUES (?, ?, 'message', '', ?, ?, 'pending', ?, ?)`,
			).run(
				"recipient-session",
				"sender-session",
				sessionPath,
				messageId,
				"2026-07-13T00:00:00.000Z",
				"2026-07-13T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => listRuntimeMailboxMessages(controlDbPath)).toThrow(/Invalid persisted JSON/);
		const unchanged = createSqliteDatabase(controlDbPath);
		try {
			expect((unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(13);
			expect(
				unchanged
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
					.get(),
			).toBeDefined();
			expect(
				(
					unchanged
						.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
						.get(sessionPath, messageId) as { data: string }
				).data,
			).toBe("not-json");
		} finally {
			unchanged.close();
		}
	});

	it("deduplicates concurrent runtime mailbox enqueues by store reference", async () => {
		const sessionPath = "/sessions/concurrent-sender.jsonl";
		const messageId = "message-concurrent";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "one durable message",
			fromAgentId: "main",
			id: messageId,
			kind: "message",
			status: "pending",
			toAgentId: "main",
		});
		const workerSource = `
			import { parentPort, workerData } from "node:worker_threads";
			import { enqueueRuntimeMailboxMessage } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/core/session-control-db.ts")).href)};
			const id = enqueueRuntimeMailboxMessage(workerData.controlDbPath, workerData.input);
			parentPort?.postMessage(id);
		`;
		const input = {
			kind: "message" as const,
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId, sessionPath },
		};
		const ids = await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise<number>((resolve, reject) => {
						const worker = new Worker(workerSource, {
							eval: true,
							execArgv: ["--experimental-strip-types"],
							workerData: { controlDbPath, input },
						});
						worker.on("message", resolve);
						worker.on("error", reject);
					}),
			),
		);

		expect(new Set(ids).size).toBe(1);
		expect(listRuntimeMailboxMessages(controlDbPath)).toHaveLength(1);
	});

	it("does not resurrect relocated legacy counters at the old session path", () => {
		const oldPath = "/sessions/legacy-counter-old.jsonl";
		const newPath = "/sessions/legacy-counter-new.jsonl";
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE multi_agent_counters (
					session_path TEXT PRIMARY KEY,
					next_agent_number INTEGER NOT NULL,
					next_message_number INTEGER NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			db.prepare(
				`INSERT INTO multi_agent_counters
				 (session_path, next_agent_number, next_message_number, updated_at)
				 VALUES (?, ?, ?, ?)`,
			).run(oldPath, 7, 9, "2026-07-11T00:00:00.000Z");
		} finally {
			db.close();
		}

		expect(readMultiAgentState(controlDbPath, oldPath)?.counters).toEqual({
			nextAgentNumber: 7,
			nextMessageNumber: 9,
		});
		relocateSessionControlData(controlDbPath, oldPath, newPath);
		expect(readMultiAgentState(controlDbPath, newPath)?.counters).toEqual({
			nextAgentNumber: 7,
			nextMessageNumber: 9,
		});
		expect(readMultiAgentState(controlDbPath, oldPath)).toBeUndefined();
		expect(allocateMultiAgentCounter(controlDbPath, oldPath, "agent")).toBe(1);
	});

	it("relocates runtime mailbox references across an existing destination reference", () => {
		const oldPath = "/sessions/old.jsonl";
		const newPath = "/sessions/new.jsonl";
		const messageId = "same-message";
		for (const sessionPath of [oldPath, newPath]) {
			upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
				body: sessionPath,
				fromAgentId: "main",
				id: messageId,
				kind: "message",
				status: "pending",
				toAgentId: "main",
			});
			enqueueRuntimeMailboxMessage(controlDbPath, {
				kind: "message",
				recipient: { agentId: null, sessionId: "recipient-session" },
				sender: { agentId: null, sessionId: "sender-session" },
				storeRef: { messageId, sessionPath },
			});
		}
		upsertMultiAgentMailboxMessage(controlDbPath, newPath, "destination-only", {
			body: "stale destination",
			fromAgentId: "main",
			id: "destination-only",
			kind: "message",
			status: "pending",
			toAgentId: "main",
		});
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
			storeRef: { messageId: "destination-only", sessionPath: newPath },
		});

		expect(() => relocateSessionControlData(controlDbPath, oldPath, newPath)).not.toThrow();
		const rows = listRuntimeMailboxMessages(controlDbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.storeRef).toEqual({ messageId, sessionPath: newPath });
	});

	it("adds runtime identities and session paths to legacy listener tables on re-registration", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE runtime_mailbox_listeners (
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id_key TEXT NOT NULL,
					pid INTEGER NOT NULL,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (recipient_session_id, recipient_agent_id_key)
				)
			`);
		} finally {
			db.close();
		}

		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "legacy-session" },
			123,
			"/sessions/legacy-session.jsonl",
		);

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({
				sessionId: "legacy-session",
				sessionPath: "/sessions/legacy-session.jsonl",
			}),
		]);
		const migrated = createSqliteDatabase(controlDbPath);
		try {
			const row = migrated
				.prepare("SELECT runtime_instance_id FROM runtime_mailbox_listeners WHERE recipient_session_id = ?")
				.get("legacy-session") as { runtime_instance_id: string };
			expect(row.runtime_instance_id).toBeTruthy();
		} finally {
			migrated.close();
		}
	});

	it("retires a matching main-session listener without removing a replacement process", () => {
		const recipient = { agentId: null, sessionId: "session-a" };
		registerRuntimeMailboxListener(controlDbPath, recipient, 123, "/sessions/session-a.jsonl");

		expect(retireRuntimeMailboxListener(controlDbPath, recipient, 456)).toBe(false);
		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({
				sessionId: "session-a",
				agentId: null,
				pid: 123,
				sessionPath: "/sessions/session-a.jsonl",
			}),
		]);
		expect(readSessionHealth(controlDbPath, "session-a")).toMatchObject({
			pid: 123,
			agentGeneration: 1,
			checkStatus: "ok",
			checkedGeneration: 1,
		});

		expect(retireRuntimeMailboxListener(controlDbPath, recipient, 123)).toBe(true);
		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([]);
		expect(readSessionHealth(controlDbPath, "session-a")).toMatchObject({
			pid: null,
			checkStatus: "dead",
			checkedGeneration: 1,
			agentGeneration: 1,
		});
	});

	it("configures read-only control DB connections with a busy timeout", () => {
		const writer = createSqliteDatabase(controlDbPath);
		writer.exec("CREATE TABLE sample (value TEXT)");
		writer.close();

		const reader = createReadOnlySqliteDatabase(controlDbPath);
		try {
			configureReadOnlySqliteDatabase(reader);
			const row = reader.prepare("PRAGMA busy_timeout").get() as { timeout?: number };
			expect(Object.values(row)[0]).toBe(5000);
		} finally {
			reader.close();
		}
	});

	it("opens control.sqlite in WAL mode for multi-consumer access", () => {
		writeLastMessage(controlDbPath, { role: "assistant", content: "prime schema" });
		const db = createSqliteDatabase(controlDbPath);
		try {
			const journal = db.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | string;
			const journalMode =
				typeof journal === "string" ? journal.toLowerCase() : String(Object.values(journal)[0] ?? "").toLowerCase();
			// journal_mode is on-disk and survives reconnects after the first control open.
			expect(journalMode).toBe("wal");

			configureSharedSqliteDatabase(db);
			const busy = db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown> | number;
			const busyTimeout = typeof busy === "number" ? busy : Number(Object.values(busy)[0] ?? Number.NaN);
			expect(busyTimeout).toBe(5000);

			const synchronous = db.prepare("PRAGMA synchronous").get() as Record<string, unknown> | number | string;
			const synchronousValue =
				typeof synchronous === "number" || typeof synchronous === "string"
					? String(synchronous).toLowerCase()
					: String(Object.values(synchronous)[0] ?? "").toLowerCase();
			expect(["1", "normal"]).toContain(synchronousValue);
		} finally {
			db.close();
		}
	});

	it("allows concurrent multi-process readers and writers on control.sqlite", async () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});

		const workerSource = `
			import { parentPort, workerData } from "node:worker_threads";
			import {
				enqueueIncomingMessage,
				listSessionMetadata,
				writeLastMessage,
			} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/core/session-control-db.ts")).href)};

			const { controlDbPath, workerId } = workerData;
			for (let i = 0; i < 25; i++) {
				enqueueIncomingMessage(controlDbPath, \`worker-\${workerId}-\${i}\`);
				writeLastMessage(controlDbPath, {
					role: "assistant",
					content: \`worker-\${workerId}-answer-\${i}\`,
				});
				listSessionMetadata(controlDbPath);
			}
			parentPort?.postMessage({ ok: true, workerId });
		`;

		const workers = Array.from({ length: 4 }, (_, workerId) => {
			return new Promise<{ ok: true; workerId: number }>((resolve, reject) => {
				const worker = new Worker(workerSource, {
					eval: true,
					execArgv: ["--experimental-strip-types"],
					workerData: { controlDbPath, workerId },
				});
				worker.on("message", resolve);
				worker.on("error", reject);
				worker.on("exit", (code) => {
					if (code !== 0) reject(new Error(`worker exited with code ${code}`));
				});
			});
		});

		const results = await Promise.all(workers);
		expect(results).toHaveLength(4);
		expect(listSessionMetadata(controlDbPath)).toHaveLength(1);
	});

	it("stores shared channel messages behind per-recipient cursors", () => {
		const first = postSharedChannelMessage(controlDbPath, {
			body: "first note",
			sender: { agentId: null, sessionId: "sender-session" },
		});
		const second = postSharedChannelMessage(controlDbPath, {
			body: "second note",
			sender: { agentId: "agent_1", sessionId: "sender-session" },
		});

		expect(second).toBeGreaterThan(first);
		expect(listSharedChannelMessagesAfter(controlDbPath, 0)).toMatchObject([
			{
				body: "first note",
				id: first,
				sender: { agentId: null, sessionId: "sender-session" },
			},
			{
				body: "second note",
				id: second,
				sender: { agentId: "agent_1", sessionId: "sender-session" },
			},
		]);

		advanceSharedChannelCursor(controlDbPath, { agentId: null, sessionId: "recipient-session" }, first);
		expect(readSharedChannelCursor(controlDbPath, { agentId: null, sessionId: "recipient-session" })).toBe(first);
		expect(listSharedChannelMessagesAfter(controlDbPath, first)).toMatchObject([{ id: second }]);
	});

	it("initializes new shared channel cursors at the current tail", () => {
		const first = postSharedChannelMessage(controlDbPath, {
			body: "old note",
			sender: { agentId: null, sessionId: "sender-session" },
		});

		const cursor = initializeSharedChannelCursorAtTail(controlDbPath, {
			agentId: null,
			sessionId: "new-session",
		});

		expect(cursor).toBe(first);
		expect(readSharedChannelCursor(controlDbPath, { agentId: null, sessionId: "new-session" })).toBe(first);
		expect(listSharedChannelMessagesAfter(controlDbPath, cursor)).toEqual([]);
	});

	it("claims only the latest pending incoming message", () => {
		enqueueIncomingMessage(controlDbPath, "older prompt");
		enqueueIncomingMessage(controlDbPath, "newer prompt");

		const claimed = claimLatestIncomingMessage(controlDbPath);

		expect(claimed?.content).toBe("newer prompt");
		expect(claimLatestIncomingMessage(controlDbPath)).toBeUndefined();
	});

	it("allows claimed incoming messages to be completed", () => {
		enqueueIncomingMessage(controlDbPath, "run this");
		const claimed = claimLatestIncomingMessage(controlDbPath);

		expect(claimed).toBeDefined();
		completeIncomingMessage(controlDbPath, claimed!.id);

		expect(readIncomingMessageStatus(controlDbPath, claimed!.id)).toBe("completed");
		expect(claimLatestIncomingMessage(controlDbPath)).toBeUndefined();
	});

	it("keeps only the latest assistant message", () => {
		writeLastMessage(controlDbPath, { role: "assistant", content: "first answer" });
		writeLastMessage(controlDbPath, { role: "assistant", content: "second answer" });

		expect(readLastMessage(controlDbPath)).toMatchObject({
			role: "assistant",
			content: "second answer",
		});
	});

	it("does not signal a non-Pi process behind a reused listener pid", async () => {
		const child = await spawnIdleNodeProcess();
		try {
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "reused-non-pi-pid" }, child.pid);
			const sessionPath = "/sessions/sender.jsonl";
			const messageId = "reused-non-pi-pid-message";
			upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
				body: "wake",
				id: messageId,
				status: "pending",
			});
			enqueueRuntimeMailboxMessage(controlDbPath, {
				kind: "message",
				recipient: { agentId: null, sessionId: "reused-non-pi-pid" },
				sender: { agentId: null, sessionId: "sender" },
				storeRef: { messageId, sessionPath },
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
		} finally {
			await stopChildProcess(child);
		}
	});

	it("stores runtime mailbox messages by recipient session and nullable agent id", () => {
		const mainMessageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "main thread notice",
			kind: "system",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const agentMessageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "subagent notice",
			kind: "message",
			recipient: { agentId: "agent_2", sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		expect(readRuntimeMailboxMessage(controlDbPath, mainMessageId)).toMatchObject({
			body: "main thread notice",
			kind: "system",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
			status: "pending",
		});
		expect(
			claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" }).map(
				(message) => message.id,
			),
		).toEqual([mainMessageId]);
		expect(readRuntimeMailboxMessage(controlDbPath, agentMessageId)).toMatchObject({ status: "pending" });
	});

	it("enforces persisted parent-request targets against the sender's direct parent", () => {
		const sessionPath = "/sessions/parent-request.jsonl";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent-child", {
			id: "agent-child",
			lifecycle: "running",
			parentId: "agent-parent",
			revision: 1,
		});
		const request = {
			body: "Need scope",
			fromAgentId: "agent-child",
			id: "message_1",
			kind: "parent_request",
			status: "pending",
			toAgentId: "supervisor",
		};

		expect(() => upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_1", request)).toThrow(
			/invalid parent request target/i,
		);
		expect(() =>
			upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_1", {
				...request,
				toAgentId: "agent-parent",
			}),
		).not.toThrow();
	});

	it("resolves store-referenced runtime mailbox bodies without copying them into transport rows", () => {
		upsertMultiAgentMailboxMessage(controlDbPath, "/sessions/supervisor.jsonl", "message_1", {
			fileRefs: [{ label: "Log", path: "/tmp/run.log" }],
			body: "stored mailbox message",
			fromAgentId: "agent_1",
			id: "message_1",
			kind: "message",
			status: "pending",
			toAgentId: "agent_2",
		});
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
			storeRef: { messageId: "message_1", sessionPath: "/sessions/supervisor.jsonl" },
		});

		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({
			fileRefs: [{ label: "Log", path: "/tmp/run.log" }],
			body: "stored mailbox message",
			kind: "message",
		});
		expect(
			claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" }).map(
				(message) => message.body,
			),
		).toEqual(["stored mailbox message"]);
		const db = createSqliteDatabase(controlDbPath);
		try {
			const runtimeTable = db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
				.get();
			const raw = db.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE rowid = ?").get(messageId) as {
				data: string;
			};
			expect(runtimeTable).toBeUndefined();
			expect(JSON.parse(raw.data)).toMatchObject({
				body: "stored mailbox message",
				recipientSessionId: "parent-session",
			});
		} finally {
			db.close();
		}
	});

	it("marks persisted store mailbox messages delivered by reference", () => {
		upsertMultiAgentMailboxMessage(controlDbPath, "/sessions/supervisor.jsonl", "message_1", {
			body: "stored supervisor request",
			fromAgentId: "agent_1",
			id: "message_1",
			kind: "system",
			status: "pending",
			toAgentId: "main",
		});

		expect(markMultiAgentMailboxMessageDelivered(controlDbPath, "/sessions/supervisor.jsonl", "message_1")).toBe(
			true,
		);
		expect(markMultiAgentMailboxMessageDelivered(controlDbPath, "/sessions/supervisor.jsonl", "message_1")).toBe(
			false,
		);
		const runtimeId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "system",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
			storeRef: { messageId: "message_1", sessionPath: "/sessions/supervisor.jsonl" },
		});

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeId)).toMatchObject({
			body: "stored supervisor request",
		});
	});

	it("claims canonical mailbox rows atomically without a runtime message table", () => {
		const firstId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "first",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const secondId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "second",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_2", sessionId: "child-session" },
		});

		const firstClaim = claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		const secondClaim = claimTestRuntimeMailboxMessages(controlDbPath, {
			agentId: null,
			sessionId: "parent-session",
		});

		expect(firstClaim.map((message) => message.id)).toEqual([firstId, secondId]);
		expect(secondClaim).toEqual([]);
		expect(readRuntimeMailboxMessage(controlDbPath, firstId)).toMatchObject({ status: "claimed" });
		expect(readRuntimeMailboxMessage(controlDbPath, secondId)).toMatchObject({ status: "claimed" });
		const db = createSqliteDatabase(controlDbPath);
		try {
			const runtimeTable = db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
				.get();
			const canonicalStatuses = db
				.prepare("SELECT json_extract(data, '$.status') AS status FROM multi_agent_mailbox_messages ORDER BY rowid")
				.all() as Array<{ status: string }>;
			expect(runtimeTable).toBeUndefined();
			expect(canonicalStatuses).toEqual([{ status: "claimed" }, { status: "claimed" }]);
		} finally {
			db.close();
		}
	});

	it("allows only the exact registered process to win a concurrent canonical claim", async () => {
		const recipient = { agentId: null, sessionId: "racing-parent" };
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "one winner",
			kind: "message",
			recipient,
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		retireRuntimeMailboxListener(controlDbPath, recipient, process.pid);
		const moduleUrl = pathToFileURL(join(process.cwd(), "src/core/session-control-db.ts")).href;
		const workerSource = `
			import { parentPort, workerData } from "node:worker_threads";
			import { claimRuntimeMailboxMessages, registerRuntimeMailboxListener } from ${JSON.stringify(moduleUrl)};
			let registered = false;
			let registrationError;
			try {
				registerRuntimeMailboxListener(workerData.controlDbPath, workerData.recipient, process.pid);
				registered = true;
			} catch (error) {
				registrationError = error instanceof Error ? error.message : String(error);
			}
			parentPort?.postMessage({ registered, registrationError, type: "ready" });
			parentPort?.once("message", () => {
				const claimed = claimRuntimeMailboxMessages(workerData.controlDbPath, workerData.recipient, 1);
				parentPort?.postMessage({ ids: claimed.map((message) => message.id), registered, type: "result" });
			});
		`;
		const workers = Array.from(
			{ length: 2 },
			() =>
				new Worker(workerSource, {
					eval: true,
					execArgv: ["--experimental-strip-types"],
					workerData: { controlDbPath, recipient },
				}),
		);
		try {
			const readyMessages = await Promise.all(workers.map((worker) => once(worker, "message")));
			expect(readyMessages.filter(([message]) => (message as { registered: boolean }).registered)).toHaveLength(1);
			const results = workers.map(
				(worker) =>
					new Promise<number[]>((resolve, reject) => {
						worker.once("message", (message: { ids: number[]; type: string }) => resolve(message.ids));
						worker.once("error", reject);
					}),
			);
			for (const worker of workers) worker.postMessage("claim");
			expect((await Promise.all(results)).flat()).toEqual([messageId]);
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	});

	it("rejects a listener with the current pid but a different process start identity", () => {
		const recipient = { agentId: null, sessionId: "stale-same-pid" };
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "stale listener",
			kind: "message",
			recipient,
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`UPDATE runtime_mailbox_listeners SET runtime_instance_id = ?
				 WHERE recipient_session_id = ? AND recipient_agent_id_key = ''`,
			).run(JSON.stringify({ pid: process.pid, startTimeTicks: 1 }), recipient.sessionId);
		} finally {
			db.close();
		}

		expect(claimRuntimeMailboxMessages(controlDbPath, recipient)).toEqual([]);
		registerRuntimeMailboxListener(controlDbPath, recipient, process.pid);
		expect(claimRuntimeMailboxMessages(controlDbPath, recipient).map((message) => message.id)).toEqual([messageId]);
	});

	it("allows a detached exact process owner to claim its canonical mailbox row", () => {
		const sessionPath = "/sessions/detached-owner.jsonl";
		const recipient = { agentId: "agent-detached", sessionId: "parent-session" };
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "detached delivery",
			kind: "message",
			recipient,
			sender: { agentId: null, sessionId: "parent-session" },
		});
		retireRuntimeMailboxListener(controlDbPath, recipient, process.pid);
		forceRuntimeOwnership(controlDbPath, {
			agentId: recipient.agentId,
			nowIso: "2026-07-13T00:00:00.000Z",
			owner: { agentId: null, sessionId: recipient.sessionId },
			processIdentity: CURRENT_PROCESS_IDENTITY,
			sessionPath,
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare("UPDATE multi_agent_mailbox_messages SET session_path = ? WHERE rowid = ?").run(
				sessionPath,
				messageId,
			);
		} finally {
			db.close();
		}

		expect(claimRuntimeMailboxMessages(controlDbPath, recipient).map((message) => message.id)).toEqual([messageId]);
	});

	it("recovers canonical mailbox claims only after exact claimant death", () => {
		const staleId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "stale",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const freshId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "fresh",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_2", sessionId: "child-session" },
		});
		claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		const db = createSqliteDatabase(controlDbPath);
		try {
			const stale = db.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE rowid = ?").get(staleId) as {
				data: string;
			};
			const payload = JSON.parse(stale.data) as Record<string, unknown>;
			payload.claimantProcessIdentity = JSON.stringify({ pid: 999_999_999, startTimeTicks: 1 });
			db.prepare("UPDATE multi_agent_mailbox_messages SET data = ? WHERE rowid = ?").run(
				JSON.stringify(payload),
				staleId,
			);
		} finally {
			db.close();
		}

		const recovered = recoverDeadRuntimeMailboxClaims(controlDbPath, {
			agentId: null,
			sessionId: "parent-session",
		});
		const claimed = claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		expect(recovered).toBe(1);
		expect(claimed.map((message) => message.id)).toEqual([staleId]);
		expect(readRuntimeMailboxMessage(controlDbPath, freshId)).toMatchObject({ status: "claimed" });
	});

	it("rejects runtime mailbox rows when the referenced store payload is malformed", () => {
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "bad file metadata",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare("UPDATE multi_agent_mailbox_messages SET data = ?").run("not json");
		} finally {
			db.close();
		}

		expect(claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" })).toEqual(
			[],
		);
		expect(() => readRuntimeMailboxMessage(controlDbPath, messageId)).toThrow(/Invalid persisted JSON/);
	});

	it("marks canonical mailbox rows delivered or failed after claim", () => {
		const deliveredId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "delivered",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const failedId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "failed",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_2", sessionId: "child-session" },
		});
		claimTestRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		markRuntimeMailboxMessageDelivered(controlDbPath, deliveredId);
		failRuntimeMailboxMessage(controlDbPath, failedId, "enqueue failed");

		expect(readRuntimeMailboxMessage(controlDbPath, deliveredId)).toMatchObject({ status: "delivered" });
		expect(readRuntimeMailboxMessage(controlDbPath, failedId)).toMatchObject({
			error: "enqueue failed",
			status: "failed",
		});
	});

	it("retires listener ownership without rewriting lifecycle rows", async () => {
		const child = await spawnIdleNodeProcess();
		const sessionPath = "/sessions/non-pi-owner.jsonl";
		const sessionId = "non-pi-owner";
		try {
			writeSessionMetadata(controlDbPath, {
				sessionPath,
				id: sessionId,
				cwd: "/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "first",
				allMessagesText: "first",
			});
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId }, child.pid, sessionPath);
			bootstrapMultiAgentAgent(controlDbPath, sessionPath, "running", {
				id: "running",
				lifecycle: "running",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});

			expect(retireRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId }, child.pid)).toBe(true);
			expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([]);
			expect(readSessionHealth(controlDbPath, sessionId)).toMatchObject({ pid: null, checkStatus: "dead" });
			expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
				{ id: "running", lifecycle: "running", revision: 1 },
			]);
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
		} finally {
			await stopChildProcess(child);
		}
	});

	it("does not reconcile inactive supervisor lifecycle rows through generic persistence APIs", () => {
		const inactiveSessionPath = "/sessions/inactive.jsonl";
		const liveSessionPath = "/sessions/live.jsonl";
		const missingHealthSessionPath = "/sessions/missing-health.jsonl";
		const missingMetadataSessionPath = "/sessions/missing-metadata.jsonl";
		const inactiveSessionId = "inactive-supervisor";
		const activeLifecycles = ["running", "waiting_for_input", "steering_pending", "cancelling"] as const;

		for (const [sessionPath, id] of [
			[inactiveSessionPath, inactiveSessionId],
			[liveSessionPath, "live-supervisor"],
			[missingHealthSessionPath, "missing-health-supervisor"],
		] as const) {
			writeSessionMetadata(controlDbPath, {
				sessionPath,
				id,
				cwd: "/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "first",
				allMessagesText: "first",
			});
		}
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth(inactiveSessionId, "2026-01-01T00:00:00.000Z"),
			checkStatus: "dead",
		});
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth("live-supervisor", "2026-01-01T00:00:00.000Z"),
			pid: process.pid,
			checkStatus: "ok",
		});

		for (const lifecycle of activeLifecycles) {
			bootstrapMultiAgentAgent(controlDbPath, inactiveSessionPath, `active-${lifecycle}`, {
				id: `active-${lifecycle}`,
				lifecycle,
				origin: lifecycle === "running" ? undefined : "spawned",
				revision: 4,
				updatedAt: "2026-01-01T00:00:00.000Z",
				worker: { adapter: "runtime", handleId: "job" },
				extra: { retained: true },
			});
		}
		for (const [id, lifecycle, origin] of [
			["running-extra", "running", "spawned"],
			["completed", "completed", "spawned"],
			["failed", "failed", "spawned"],
			["aborted", "aborted", "spawned"],
			["attached", "running", "attached"],
		] as const) {
			bootstrapMultiAgentAgent(controlDbPath, inactiveSessionPath, id, {
				id,
				lifecycle,
				origin,
				revision: 4,
				updatedAt: "2026-01-01T00:00:00.000Z",
				worker: { adapter: "runtime", handleId: "job" },
			});
		}
		bootstrapMultiAgentAgent(controlDbPath, liveSessionPath, "live", {
			id: "live",
			lifecycle: "running",
			revision: 4,
			updatedAt: "2026-01-01T00:00:00.000Z",
			worker: { adapter: "runtime", handleId: "job" },
		});
		bootstrapMultiAgentAgent(controlDbPath, missingHealthSessionPath, "missing-health", {
			id: "missing-health",
			lifecycle: "running",
			revision: 4,
			updatedAt: "2026-01-01T00:00:00.000Z",
			worker: { adapter: "runtime", handleId: "job" },
		});
		bootstrapMultiAgentAgent(controlDbPath, missingMetadataSessionPath, "missing-metadata", {
			id: "missing-metadata",
			lifecycle: "running",
			revision: 4,
			updatedAt: "2026-01-01T00:00:00.000Z",
			worker: { adapter: "runtime", handleId: "job" },
		});

		const inactiveAgents = readMultiAgentState(controlDbPath, inactiveSessionPath)?.agents as Array<
			Record<string, unknown>
		>;
		for (const lifecycle of activeLifecycles) {
			expect(inactiveAgents.find((agent) => agent.id === `active-${lifecycle}`)).toMatchObject({
				lifecycle,
				revision: 4,
				extra: { retained: true },
				worker: { adapter: "runtime", handleId: "job" },
			});
		}
		expect(inactiveAgents).toHaveLength(activeLifecycles.length + 5);
		expect(readMultiAgentState(controlDbPath, liveSessionPath)?.agents).toMatchObject([
			{ id: "live", lifecycle: "running" },
		]);
		expect(readMultiAgentState(controlDbPath, missingHealthSessionPath)?.agents).toMatchObject([
			{ id: "missing-health", lifecycle: "running" },
		]);
		expect(readMultiAgentState(controlDbPath, missingMetadataSessionPath)?.agents).toMatchObject([
			{ id: "missing-metadata", lifecycle: "running" },
		]);
	});

	it("relocates the live listener path atomically with its multi-agent store", () => {
		const oldSessionPath = "/sessions/live-old.jsonl";
		const newSessionPath = "/sessions/live-new.jsonl";
		writeSessionMetadata(controlDbPath, {
			sessionPath: oldSessionPath,
			id: "live-session",
			cwd: "/repo",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "live-session" }, 123, oldSessionPath);
		bootstrapMultiAgentAgent(controlDbPath, oldSessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		relocateSessionControlData(controlDbPath, oldSessionPath, newSessionPath);

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "live-session", sessionPath: newSessionPath }),
		]);
		expect(readMultiAgentState(controlDbPath, newSessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("clears listener path trust when a heartbeat cannot assert its session path", () => {
		const assertedSessionPath = "/sessions/asserted.jsonl";
		const unknownSessionPath = "/sessions/unknown.jsonl";
		for (const sessionPath of [assertedSessionPath, unknownSessionPath]) {
			writeSessionMetadata(controlDbPath, {
				sessionPath,
				id: "live-session",
				cwd: "/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "first",
				allMessagesText: "first",
			});
		}
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "live-session" },
			123,
			assertedSessionPath,
		);
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "live-session" }, 123);
		bootstrapMultiAgentAgent(controlDbPath, unknownSessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "live-session", sessionPath: undefined }),
		]);
		expect(readMultiAgentState(controlDbPath, unknownSessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("distrusts a listener path after a legacy heartbeat updates only its timestamp", () => {
		const assertedSessionPath = "/sessions/asserted.jsonl";
		const unknownSessionPath = "/sessions/unknown.jsonl";
		for (const sessionPath of [assertedSessionPath, unknownSessionPath]) {
			writeSessionMetadata(controlDbPath, {
				sessionPath,
				id: "live-session",
				cwd: "/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "first",
				allMessagesText: "first",
			});
		}
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "live-session" },
			123,
			assertedSessionPath,
		);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				"UPDATE runtime_mailbox_listeners SET updated_at = ? WHERE recipient_session_id = ? AND recipient_agent_id_key = ''",
			).run("2099-01-01T00:00:00.000Z", "live-session");
		} finally {
			db.close();
		}
		bootstrapMultiAgentAgent(controlDbPath, unknownSessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "live-session", sessionPath: undefined }),
		]);
		expect(readMultiAgentState(controlDbPath, unknownSessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("explains how to recover when another live runtime owns the session", () => {
		const sessionPath = "/sessions/concurrent-runtime.jsonl";
		const recipient = { agentId: null, sessionId: "concurrent-runtime-session" };
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: recipient.sessionId,
			cwd: "/repo",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});
		registerRuntimeMailboxListener(controlDbPath, recipient, 111, sessionPath, {
			runtimeInstanceId: "runtime-a",
		});
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(() =>
			registerRuntimeMailboxListener(controlDbPath, recipient, 222, sessionPath, {
				isRuntimeProcessAlive: () => true,
				runtimeInstanceId: "runtime-b",
			}),
		).toThrow(
			"Cannot continue session concurrent-runtime-session because it is open in another Pi process (PID 111, cwd /repo). Close that Pi session, run pi to start a new session, or use pi -r to choose another.",
		);

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ pid: 111, sessionId: recipient.sessionId, sessionPath }),
		]);
		expect(readSessionHealth(controlDbPath, recipient.sessionId)).toMatchObject({
			pid: 111,
			agentGeneration: 1,
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("advances generation without mutating lifecycle rows when a new runtime reuses the same pid", () => {
		const sessionPath = "/sessions/reused-pid.jsonl";
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: "reused-pid-session",
			cwd: "/repo",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "reused-pid-session" },
			123,
			sessionPath,
			{ runtimeInstanceId: JSON.stringify({ pid: 123, startTimeTicks: 1 }) },
		);
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "attached", {
			id: "attached",
			lifecycle: "running",
			origin: "attached",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "reused-pid-session" },
			123,
			sessionPath,
			{ runtimeInstanceId: JSON.stringify({ pid: 123, startTimeTicks: 2 }) },
		);

		expect(readSessionHealth(controlDbPath, "reused-pid-session")).toMatchObject({
			pid: 123,
			agentGeneration: 2,
			checkStatus: "ok",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "attached", lifecycle: "running", revision: 1 }),
				expect.objectContaining({ id: "running", lifecycle: "running", revision: 1 }),
			]),
		);
	});

	it("lets the current runtime restore its own missing listener without aborting spawned rows", () => {
		const sessionPath = "/sessions/touched-runtime.jsonl";
		const recipient = { agentId: null, sessionId: "touched-runtime-session" };
		registerRuntimeMailboxListener(controlDbPath, recipient, 123, sessionPath, { runtimeInstanceId: "runtime-a" });
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare("DELETE FROM runtime_mailbox_listeners WHERE recipient_session_id = ?").run(recipient.sessionId);
		} finally {
			db.close();
		}

		registerRuntimeMailboxListener(controlDbPath, recipient, 123, sessionPath, {
			reconcileRuntimeReplacement: false,
			runtimeInstanceId: "runtime-b",
		});

		expect(readSessionHealth(controlDbPath, recipient.sessionId)).toMatchObject({
			pid: 123,
			agentGeneration: 1,
			checkStatus: "ok",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("keeps the generation and spawned rows on heartbeats from the same runtime", () => {
		const sessionPath = "/sessions/same-runtime.jsonl";
		const recipient = { agentId: null, sessionId: "same-runtime-session" };
		registerRuntimeMailboxListener(controlDbPath, recipient, 123, sessionPath, { runtimeInstanceId: "runtime-a" });
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		registerRuntimeMailboxListener(controlDbPath, recipient, 123, sessionPath, { runtimeInstanceId: "runtime-a" });

		expect(readSessionHealth(controlDbPath, "same-runtime-session")).toMatchObject({
			pid: 123,
			agentGeneration: 1,
			checkStatus: "ok",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("resolves this process's own main coordination recipient from the asserted listener row", () => {
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "main-session" },
			process.pid,
			"/sessions/main-session.jsonl",
		);
		// A child listener under the same process must never be selected.
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: "agent_child", sessionId: "child-session" },
			process.pid,
		);

		expect(resolveOwnMainRuntimeCoordinationRecipient(controlDbPath)).toEqual({
			agentId: null,
			sessionId: "main-session",
		});
	});

	it("does not resolve a main recipient owned by a different process identity", () => {
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "foreign-session" },
			CURRENT_PROCESS_IDENTITY.pid + 1,
			"/sessions/foreign-session.jsonl",
			{ reconcileRuntimeReplacement: false, runtimeInstanceId: JSON.stringify(testProcessIdentity("foreign")) },
		);

		expect(resolveOwnMainRuntimeCoordinationRecipient(controlDbPath)).toBeUndefined();
	});

	it("does not resolve a main recipient whose session path is not asserted", () => {
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "unasserted-session" }, process.pid);

		expect(resolveOwnMainRuntimeCoordinationRecipient(controlDbPath)).toBeUndefined();
	});

	it("returns undefined when no listener is registered for this process", () => {
		expect(resolveOwnMainRuntimeCoordinationRecipient(controlDbPath)).toBeUndefined();
	});

	it("stores and removes named sessions", () => {
		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha");
		setNamedSession(controlDbPath, "/tmp/session-b.jsonl", "Beta");
		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha renamed");

		const namedSessions = listNamedSessions(controlDbPath)
			.map((session) => [session.sessionPath, session.name])
			.sort(([left], [right]) => left.localeCompare(right));
		expect(namedSessions).toEqual([
			["/tmp/session-a.jsonl", "Alpha renamed"],
			["/tmp/session-b.jsonl", "Beta"],
		]);

		removeNamedSession(controlDbPath, "/tmp/session-a.jsonl");

		expect(listNamedSessions(controlDbPath).map((session) => [session.sessionPath, session.name])).toEqual([
			["/tmp/session-b.jsonl", "Beta"],
		]);
	});

	it("stores and lists session metadata ordered by modified time", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: "Alpha",
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 2,
			firstMessage: "first alpha",
			allMessagesText: "first alpha assistant alpha",
		});
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-b.jsonl",
			id: "session-b",
			cwd: "/repo/b",
			name: undefined,
			parentSessionPath: "/tmp/session-a.jsonl",
			createdAt: "2026-01-02T00:00:00.000Z",
			modifiedAt: "2026-01-02T00:05:00.000Z",
			messageCount: 1,
			firstMessage: "first beta",
			allMessagesText: "first beta",
		});

		const sessions = listSessionMetadata(controlDbPath);

		expect(sessions).toMatchObject([
			{
				sessionPath: "/tmp/session-b.jsonl",
				id: "session-b",
				cwd: "/repo/b",
				name: undefined,
				parentSessionPath: "/tmp/session-a.jsonl",
				createdAt: "2026-01-02T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:05:00.000Z",
				messageCount: 1,
				firstMessage: "first beta",
				allMessagesText: "first beta",
			},
			{
				sessionPath: "/tmp/session-a.jsonl",
				id: "session-a",
				cwd: "/repo/a",
				name: "Alpha",
				parentSessionPath: undefined,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:10:00.000Z",
				messageCount: 2,
				firstMessage: "first alpha",
				allMessagesText: "first alpha assistant alpha",
			},
		]);
		expect(sessions[0].updatedAt).toEqual(expect.any(String));
	});

	it("archives and restores session metadata without changing transcript data", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});

		archiveSession(controlDbPath, "/tmp/session-a.jsonl");
		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")).toMatchObject({
			id: "session-a",
			isArchived: true,
		});

		unarchiveSession(controlDbPath, "/tmp/session-a.jsonl");
		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")).toMatchObject({
			id: "session-a",
			isArchived: false,
		});
	});

	it("archives only non-subagent sessions older than the cutoff", () => {
		for (const metadata of [
			{
				sessionPath: "/tmp/old.jsonl",
				id: "old",
				cwd: "/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "old",
				allMessagesText: "old",
			},
			{
				sessionPath: "/tmp/new.jsonl",
				id: "new",
				cwd: "/repo",
				createdAt: "2026-01-03T00:00:00.000Z",
				modifiedAt: "2026-01-03T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "new",
				allMessagesText: "new",
			},
			{
				sessionPath: "/tmp/child.jsonl",
				id: "child",
				cwd: "/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:00:00.000Z",
				messageCount: 1,
				firstMessage: "child",
				allMessagesText: "child",
				isSubagent: true,
			},
		]) {
			writeSessionMetadata(controlDbPath, metadata);
		}

		expect(archiveSessionsOlderThan(controlDbPath, new Date("2026-01-02T00:00:00.000Z"))).toEqual(["/tmp/old.jsonl"]);
		expect(readSessionMetadata(controlDbPath, "/tmp/old.jsonl")).toMatchObject({ isArchived: true });
		expect(readSessionMetadata(controlDbPath, "/tmp/new.jsonl")).toMatchObject({ isArchived: false });
		expect(readSessionMetadata(controlDbPath, "/tmp/child.jsonl")).toMatchObject({ isArchived: false });
		expect(
			listActiveSessionMetadata(controlDbPath)
				.map((session) => session.sessionPath)
				.sort(),
		).toEqual(["/tmp/child.jsonl", "/tmp/new.jsonl"]);
		expect(listArchivedSessionMetadata(controlDbPath).map((session) => session.sessionPath)).toEqual([
			"/tmp/old.jsonl",
		]);
	});

	it("updates existing session metadata without changing its session path", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: "Original",
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a-renamed",
			cwd: "/repo/a2",
			name: undefined,
			parentSessionPath: "/tmp/parent.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:20:00.000Z",
			messageCount: 3,
			firstMessage: "updated first",
			allMessagesText: "updated first more text",
		});

		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")).toMatchObject({
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a-renamed",
			cwd: "/repo/a2",
			name: undefined,
			parentSessionPath: "/tmp/parent.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:20:00.000Z",
			messageCount: 3,
			firstMessage: "updated first",
			allMessagesText: "updated first more text",
		});
	});

	it("adds goal and subagent columns to existing session metadata tables", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE session_metadata (
					session_path TEXT PRIMARY KEY,
					id TEXT NOT NULL,
					cwd TEXT NOT NULL,
					name TEXT,
					parent_session_path TEXT,
					created_at TEXT NOT NULL,
					modified_at TEXT NOT NULL,
					message_count INTEGER NOT NULL,
					first_message TEXT NOT NULL,
					all_messages_text TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
		} finally {
			db.close();
		}

		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
			isSubagent: true,
			subagentName: "researcher",
		});
		writeSessionGoal(controlDbPath, "/tmp/session-a.jsonl", '{"objective":"migrated"}');

		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")).toMatchObject({
			goalJson: '{"objective":"migrated"}',
			isSubagent: true,
			subagentName: "researcher",
		});
	});

	it("stores goal and subagent metadata in the session metadata row", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: "Alpha",
			parentSessionPath: "/tmp/parent.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
			isSubagent: true,
			subagentName: "researcher",
		});

		writeSessionGoal(controlDbPath, "/tmp/session-a.jsonl", '{"objective":"child objective"}');

		const metadata = readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl");
		expect(metadata).toMatchObject({
			goalJson: '{"objective":"child objective"}',
			isSubagent: true,
			subagentName: "researcher",
		});
		expect(readSessionGoal(controlDbPath, "/tmp/session-a.jsonl")).toBe('{"objective":"child objective"}');
	});

	it("keeps named session APIs compatible while mirroring names into metadata", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});

		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha");
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:20:00.000Z",
			messageCount: 2,
			firstMessage: "first",
			allMessagesText: "first second",
		});

		expect(listNamedSessions(controlDbPath)).toMatchObject([{ sessionPath: "/tmp/session-a.jsonl", name: "Alpha" }]);
		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")?.name).toBe("Alpha");

		removeNamedSession(controlDbPath, "/tmp/session-a.jsonl");

		expect(listNamedSessions(controlDbPath)).toEqual([]);
		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")?.name).toBeUndefined();
	});
});
