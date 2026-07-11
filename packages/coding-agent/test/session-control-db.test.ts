import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	abortInactiveSessionSpawnedAgents,
	abortPersistedSpawnedAgentsForInactiveSupervisorSession,
	advanceSharedChannelCursor,
	allocateMultiAgentCounter,
	archiveSession,
	archiveSessionsOlderThan,
	claimLatestIncomingMessage,
	claimPendingArchitectRequests,
	claimRuntimeMailboxMessages,
	cleanupRuntimeMailboxMessages,
	completeArchitectRequest,
	completeIncomingMessage,
	consumeRuntimeMailboxMessage,
	deliverRuntimeMailboxMessage,
	enqueueIncomingMessage,
	enqueueRuntimeMailboxMessage,
	failRuntimeMailboxMessage,
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
	readIncomingMessageStatus,
	readLastMessage,
	readMultiAgentState,
	readRuntimeMailboxMessage,
	readSessionGoal,
	readSessionHealth,
	readSessionMetadata,
	readSharedChannelCursor,
	recoverStaleRuntimeMailboxClaims,
	registerRuntimeMailboxListener,
	relocateSessionControlData,
	removeNamedSession,
	renewArchitectRequestClaims,
	retireRuntimeMailboxListener,
	setNamedSession,
	unarchiveSession,
	upsertMultiAgentAgent,
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
		).toThrow("conflicts with existing runtime mailbox row");
	});

	it("delivers the durable store row and transport row atomically", () => {
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

	it("rolls back durable delivery when transport delivery fails", () => {
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
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TRIGGER reject_runtime_delivery
				BEFORE UPDATE OF status ON runtime_mailbox_messages
				WHEN OLD.id = ${id}
				BEGIN
					SELECT RAISE(ABORT, 'reject transport delivery');
				END
			`);
		} finally {
			db.close();
		}

		expect(() => deliverRuntimeMailboxMessage(controlDbPath, id)).toThrow("reject transport delivery");
		expect(readRuntimeMailboxMessage(controlDbPath, id)?.status).toBe("pending");
		const reader = createSqliteDatabase(controlDbPath);
		try {
			const row = reader
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, messageId) as { data: string };
			expect(JSON.parse(row.data).status).toBe("pending");
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
		claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "recipient-session" });
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

	it("rejects legacy runtime mailbox rows without a store reference", () => {
		readMultiAgentState(controlDbPath, "/sessions/legacy-runtime.jsonl");
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				`INSERT INTO runtime_mailbox_messages
				 (recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind, body,
				  status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			).run(
				"recipient-session",
				null,
				"sender-session",
				null,
				"message",
				"copied legacy body",
				"2026-07-11T00:00:00.000Z",
				"2026-07-11T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(() => listRuntimeMailboxMessages(controlDbPath)).toThrow(/storeRef/i);
		expect(() => markRuntimeMailboxMessageDelivered(controlDbPath, 1)).toThrow(/storeRef/i);
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
			expect(version.user_version).toBe(2);
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
			expect(version.user_version).toBe(2);
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

	it("preserves delivered status when migrating duplicate runtime mailbox rows", () => {
		const id = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "delivered once",
			kind: "message",
			recipient: { agentId: null, sessionId: "recipient-session" },
			sender: { agentId: null, sessionId: "sender-session" },
		});
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec("DROP INDEX runtime_mailbox_store_ref_unique_idx");
			db.prepare(
				`INSERT INTO runtime_mailbox_messages
				 (recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind, body,
				  store_session_path, store_message_id, status, created_at, updated_at, claimed_at, delivered_at, error)
				 SELECT recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind, body,
				  store_session_path, store_message_id, 'delivered', created_at, updated_at, claimed_at, delivered_at, error
				 FROM runtime_mailbox_messages WHERE id = ?`,
			).run(id);
		} finally {
			db.close();
		}

		const rows = listRuntimeMailboxMessages(controlDbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("delivered");
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
			claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" }).map(
				(message) => message.id,
			),
		).toEqual([mainMessageId]);
		expect(readRuntimeMailboxMessage(controlDbPath, agentMessageId)).toMatchObject({ status: "pending" });
	});

	it("resolves store-referenced runtime mailbox bodies without copying them into transport rows", () => {
		upsertMultiAgentMailboxMessage(controlDbPath, "/sessions/supervisor.jsonl", "message_1", {
			fileRefs: [{ label: "Log", path: "/tmp/run.log" }],
			body: "stored supervisor request",
			fromAgentId: "agent_1",
			id: "message_1",
			kind: "supervisor_request",
			status: "pending",
			toAgentId: "supervisor",
		});
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "supervisor_request",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
			storeRef: { messageId: "message_1", sessionPath: "/sessions/supervisor.jsonl" },
		});

		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({
			fileRefs: [{ label: "Log", path: "/tmp/run.log" }],
			body: "stored supervisor request",
			kind: "supervisor_request",
		});
		expect(
			claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" }).map(
				(message) => message.body,
			),
		).toEqual(["stored supervisor request"]);
		const db = createSqliteDatabase(controlDbPath);
		try {
			const raw = db
				.prepare("SELECT body, store_session_path FROM runtime_mailbox_messages WHERE id = ?")
				.get(messageId) as { body: string; store_session_path: string | null };
			expect(raw.body).toBe("");
			expect(raw.store_session_path).toBe("/sessions/supervisor.jsonl");
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

	it("claims runtime mailbox rows atomically before delivery", () => {
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

		const firstClaim = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		const secondClaim = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		expect(firstClaim.map((message) => message.id)).toEqual([firstId, secondId]);
		expect(secondClaim).toEqual([]);
		expect(readRuntimeMailboxMessage(controlDbPath, firstId)).toMatchObject({ status: "claimed" });
		expect(readRuntimeMailboxMessage(controlDbPath, secondId)).toMatchObject({ status: "claimed" });
	});

	it("recovers stale claimed runtime mailbox rows for bounded redelivery", () => {
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
		claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare("UPDATE runtime_mailbox_messages SET claimed_at = ?, updated_at = ? WHERE id = ?").run(
				"2026-07-04T00:00:00.000Z",
				"2026-07-04T00:00:00.000Z",
				staleId,
			);
			db.prepare("UPDATE runtime_mailbox_messages SET claimed_at = ?, updated_at = ? WHERE id = ?").run(
				"2026-07-04T00:04:30.000Z",
				"2026-07-04T00:04:30.000Z",
				freshId,
			);
		} finally {
			db.close();
		}

		const recovered = recoverStaleRuntimeMailboxClaims(
			controlDbPath,
			{ agentId: null, sessionId: "parent-session" },
			{ nowIso: "2026-07-04T00:05:00.000Z", staleAfterMs: 60_000 },
		);
		const claimed = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

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

		expect(() => claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" })).toThrow(
			/Invalid persisted JSON/,
		);
		expect(() => readRuntimeMailboxMessage(controlDbPath, messageId)).toThrow(/Invalid persisted JSON/);
	});

	it("marks runtime mailbox rows delivered only after enqueue and failed on enqueue failure", () => {
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
		claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		markRuntimeMailboxMessageDelivered(controlDbPath, deliveredId);
		failRuntimeMailboxMessage(controlDbPath, failedId, "enqueue failed");

		expect(readRuntimeMailboxMessage(controlDbPath, deliveredId)).toMatchObject({ status: "delivered" });
		expect(readRuntimeMailboxMessage(controlDbPath, failedId)).toMatchObject({
			error: "enqueue failed",
			status: "failed",
		});
	});

	it("cleans runtime mailbox rows older than thirty days", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE runtime_mailbox_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id TEXT,
					sender_session_id TEXT,
					sender_agent_id TEXT,
					kind TEXT NOT NULL,
					body TEXT NOT NULL,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					claimed_at TEXT,
					delivered_at TEXT,
					error TEXT
				);
			`);
			db.prepare(
				`INSERT INTO runtime_mailbox_messages (recipient_session_id, kind, body, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("parent-session", "message", "old", "pending", "2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
			db.prepare(
				`INSERT INTO runtime_mailbox_messages (recipient_session_id, kind, body, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("parent-session", "message", "new", "pending", "2026-06-15T00:00:00.000Z", "2026-06-15T00:00:00.000Z");
		} finally {
			db.close();
		}

		expect(cleanupRuntimeMailboxMessages(controlDbPath, "2026-07-01T00:00:00.000Z")).toBe(1);
		expect(() => listRuntimeMailboxMessages(controlDbPath)).toThrow(/storeRef/);
	});

	it("retires non-Pi listener ownership before startup reconciliation", async () => {
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
			upsertMultiAgentAgent(controlDbPath, sessionPath, "running", {
				id: "running",
				lifecycle: "running",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});

			expect(abortInactiveSessionSpawnedAgents(controlDbPath)).toBe(1);
			expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([]);
			expect(readSessionHealth(controlDbPath, sessionId)).toMatchObject({ pid: null, checkStatus: "dead" });
			expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
				{ id: "running", lifecycle: "aborted", revision: 2, error: { code: "supervisor_restarted" } },
			]);
			expect(child.exitCode).toBeNull();
			expect(child.signalCode).toBeNull();
		} finally {
			await stopChildProcess(child);
		}
	});

	it("aborts only active spawned agents in inactive supervisor stores and is idempotent", () => {
		const inactiveSessionPath = "/sessions/inactive.jsonl";
		const liveSessionPath = "/sessions/live.jsonl";
		const missingHealthSessionPath = "/sessions/missing-health.jsonl";
		const missingMetadataSessionPath = "/sessions/missing-metadata.jsonl";
		const inactiveSessionId = "inactive-supervisor";
		const activeLifecycles = ["starting", "running", "waiting_for_input", "steering_pending", "cancelling"] as const;

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
			upsertMultiAgentAgent(controlDbPath, inactiveSessionPath, `active-${lifecycle}`, {
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
			["queued", "queued", "spawned"],
			["completed", "completed", "spawned"],
			["failed", "failed", "spawned"],
			["aborted", "aborted", "spawned"],
			["attached", "running", "attached"],
		] as const) {
			upsertMultiAgentAgent(controlDbPath, inactiveSessionPath, id, {
				id,
				lifecycle,
				origin,
				revision: 4,
				updatedAt: "2026-01-01T00:00:00.000Z",
				worker: { adapter: "runtime", handleId: "job" },
			});
		}
		upsertMultiAgentAgent(controlDbPath, liveSessionPath, "live", {
			id: "live",
			lifecycle: "running",
			revision: 4,
			updatedAt: "2026-01-01T00:00:00.000Z",
			worker: { adapter: "runtime", handleId: "job" },
		});
		upsertMultiAgentAgent(controlDbPath, missingHealthSessionPath, "missing-health", {
			id: "missing-health",
			lifecycle: "running",
			revision: 4,
			updatedAt: "2026-01-01T00:00:00.000Z",
			worker: { adapter: "runtime", handleId: "job" },
		});
		upsertMultiAgentAgent(controlDbPath, missingMetadataSessionPath, "missing-metadata", {
			id: "missing-metadata",
			lifecycle: "running",
			revision: 4,
			updatedAt: "2026-01-01T00:00:00.000Z",
			worker: { adapter: "runtime", handleId: "job" },
		});

		expect(abortPersistedSpawnedAgentsForInactiveSupervisorSession(controlDbPath, inactiveSessionPath)).toBe(
			activeLifecycles.length,
		);
		expect(abortInactiveSessionSpawnedAgents(controlDbPath, { nowIso: "2026-01-02T00:00:00.000Z" })).toBe(0);

		const inactiveAgents = readMultiAgentState(controlDbPath, inactiveSessionPath)?.agents as Array<
			Record<string, unknown>
		>;
		for (const lifecycle of activeLifecycles) {
			expect(inactiveAgents.find((agent) => agent.id === `active-${lifecycle}`)).toMatchObject({
				lifecycle: "aborted",
				revision: 5,
				error: {
					code: "supervisor_restarted",
					message: "Spawned agent was interrupted because its supervisor session is no longer active.",
				},
				extra: { retained: true },
			});
			expect(inactiveAgents.find((agent) => agent.id === `active-${lifecycle}`)?.worker).toBeUndefined();
		}
		expect(
			inactiveAgents
				.filter((agent) => agent.lifecycle !== "aborted")
				.map((agent) => agent.id)
				.sort(),
		).toEqual(["attached", "completed", "failed", "queued"]);
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
		upsertMultiAgentAgent(controlDbPath, oldSessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		relocateSessionControlData(controlDbPath, oldSessionPath, newSessionPath);

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "live-session", sessionPath: newSessionPath }),
		]);
		expect(abortInactiveSessionSpawnedAgents(controlDbPath, { isRuntimeProcessAlive: () => true })).toBe(0);
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
		upsertMultiAgentAgent(controlDbPath, unknownSessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "live-session", sessionPath: undefined }),
		]);
		expect(abortInactiveSessionSpawnedAgents(controlDbPath, { isRuntimeProcessAlive: () => true })).toBe(0);
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
		upsertMultiAgentAgent(controlDbPath, unknownSessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "live-session", sessionPath: undefined }),
		]);
		expect(abortInactiveSessionSpawnedAgents(controlDbPath, { isRuntimeProcessAlive: () => true })).toBe(0);
		expect(readMultiAgentState(controlDbPath, unknownSessionPath)?.agents).toMatchObject([
			{ id: "running", lifecycle: "running", revision: 1 },
		]);
	});

	it("rejects a different live runtime process without aborting its spawned rows", () => {
		const sessionPath = "/sessions/concurrent-runtime.jsonl";
		const recipient = { agentId: null, sessionId: "concurrent-runtime-session" };
		registerRuntimeMailboxListener(controlDbPath, recipient, 111, sessionPath, {
			runtimeInstanceId: "runtime-a",
		});
		upsertMultiAgentAgent(controlDbPath, sessionPath, "running", {
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
		).toThrow(/already owned by live Pi process 111/);

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

	it("advances generation and aborts stale spawned rows when a new runtime reuses the same pid", () => {
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
			{ runtimeInstanceId: "runtime-a" },
		);
		upsertMultiAgentAgent(controlDbPath, sessionPath, "running", {
			id: "running",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		upsertMultiAgentAgent(controlDbPath, sessionPath, "attached", {
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
			{ runtimeInstanceId: "runtime-b" },
		);

		expect(readSessionHealth(controlDbPath, "reused-pid-session")).toMatchObject({
			pid: 123,
			agentGeneration: 2,
			checkStatus: "ok",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "attached", lifecycle: "running", revision: 1 }),
				expect.objectContaining({
					id: "running",
					lifecycle: "aborted",
					revision: 2,
					error: expect.objectContaining({ code: "supervisor_restarted" }),
				}),
			]),
		);
	});

	it("lets the current runtime restore its own missing listener without aborting spawned rows", () => {
		const sessionPath = "/sessions/touched-runtime.jsonl";
		const recipient = { agentId: null, sessionId: "touched-runtime-session" };
		registerRuntimeMailboxListener(controlDbPath, recipient, 123, sessionPath, { runtimeInstanceId: "runtime-a" });
		upsertMultiAgentAgent(controlDbPath, sessionPath, "running", {
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
		upsertMultiAgentAgent(controlDbPath, sessionPath, "running", {
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
