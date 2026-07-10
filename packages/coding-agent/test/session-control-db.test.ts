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
	claimLatestIncomingMessage,
	claimRuntimeMailboxMessages,
	cleanupRuntimeMailboxMessages,
	completeIncomingMessage,
	enqueueIncomingMessage,
	enqueueRuntimeMailboxMessage,
	failRuntimeMailboxMessage,
	getControlDbPath,
	initializeSharedChannelCursorAtTail,
	listNamedSessions,
	listRuntimeMailboxListeners,
	listRuntimeMailboxMessages,
	listSessionMetadata,
	listSharedChannelMessagesAfter,
	markMultiAgentMailboxMessageDelivered,
	markRuntimeMailboxMessageDelivered,
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
	removeNamedSession,
	retireRuntimeMailboxListener,
	setNamedSession,
	upsertMultiAgentAgent,
	upsertMultiAgentMailboxMessage,
	writeLastMessage,
	writeSessionGoal,
	writeSessionHealth,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";
import { configureSharedSqliteDatabase, createSqliteDatabase } from "../src/core/sqlite.ts";

let storedMessageCounter = 0;

function enqueueStoredRuntimeMessage(
	controlDbPath: string,
	input: {
		body: string;
		kind: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["kind"];
		recipient: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["recipient"];
		sender: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["sender"];
		artifactIds?: string[];
		artifactRefs?: Array<{ id?: string; path?: string; label?: string }>;
	},
): number {
	storedMessageCounter += 1;
	const messageId = `message_${storedMessageCounter}`;
	const sessionPath = "/sessions/test-sender.jsonl";
	upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
		artifactIds: input.artifactIds,
		artifactRefs: input.artifactRefs,
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

	it("retires a matching main-session listener without removing a replacement process", () => {
		const recipient = { agentId: null, sessionId: "session-a" };
		registerRuntimeMailboxListener(controlDbPath, recipient, 123);

		expect(retireRuntimeMailboxListener(controlDbPath, recipient, 456)).toBe(false);
		expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([
			expect.objectContaining({ sessionId: "session-a", agentId: null, pid: 123 }),
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
			artifactRefs: [{ id: "artifact_1", label: "Log", path: "artifacts/run.log" }],
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
			artifactRefs: [{ id: "artifact_1", label: "Log", path: "artifacts/run.log" }],
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
				.prepare("SELECT body, artifact_refs_json FROM runtime_mailbox_messages WHERE id = ?")
				.get(messageId) as { body: string; artifact_refs_json: string | null };
			expect(raw.body).toBe("");
			expect(raw.artifact_refs_json).toBeNull();
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

	it("claims runtime mailbox rows even when the referenced store payload is malformed", () => {
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			artifactIds: ["artifact_1"],
			body: "bad artifact metadata",
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

		const claimed = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		expect(claimed).toMatchObject([{ artifactIds: undefined, body: "", id: messageId }]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "claimed" });
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
					artifact_ids_json TEXT,
					artifact_refs_json TEXT,
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
		expect(listRuntimeMailboxMessages(controlDbPath).map((message) => message.body)).toEqual(["new"]);
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
		expect(abortInactiveSessionSpawnedAgents(controlDbPath, "2026-01-02T00:00:00.000Z")).toBe(0);

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
