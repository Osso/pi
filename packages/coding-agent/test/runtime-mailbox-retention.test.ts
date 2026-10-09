import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "../src/core/mailbox-retention.ts";
import {
	claimRuntimeMailboxMessages,
	consumeRuntimeMailboxMessageByStoreRef,
	deliverRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	getControlDbPath,
	getMultiAgentMailboxMessageStatus,
	listRuntimeMailboxMessages,
	markMultiAgentMailboxMessageDelivered,
	readMultiAgentState,
	readRuntimeMailboxMessage,
	readRuntimeMailboxMessageForDelivery,
	registerRuntimeMailboxListener,
	retainControlDbConnection,
	takeRuntimeMailboxMessagesForDelivery,
	upsertMultiAgentMailboxMessage,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase, type SqliteDatabase } from "../src/core/sqlite.ts";
import { withHeadlessPi } from "./suite/headless-pi.ts";

const now = Date.parse("2026-10-08T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
const sessionPath = "/sessions/retention.jsonl";
const recipient = { sessionId: "retention-recipient", agentId: null };
const sender = { sessionId: "retention-sender", agentId: null };

function message(id: string, createdAt: unknown, status = "pending") {
	return {
		id,
		fromAgentId: "main",
		toAgentId: "main",
		kind: "message" as const,
		body: `body ${id}`,
		createdAt,
		updatedAt: new Date(now).toISOString(),
		status,
		recipientSessionId: recipient.sessionId,
		recipientAgentId: null,
		senderSessionId: sender.sessionId,
		senderAgentId: null,
	};
}

function insert(db: SqliteDatabase, id: string, createdAt: unknown, status = "pending"): number {
	return Number(
		db
			.prepare(
				"INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at) VALUES (?, ?, ?, ?)",
			)
			.run(sessionPath, id, JSON.stringify(message(id, createdAt, status)), new Date(now).toISOString())
			.lastInsertRowid,
	);
}

function rows(db: SqliteDatabase): string[] {
	return (
		db.prepare("SELECT message_id FROM multi_agent_mailbox_messages ORDER BY rowid").all() as { message_id: string }[]
	).map((row) => row.message_id);
}

function waitForWorkerCompletion(worker: Worker): Promise<{ done: boolean; error?: string }> {
	return new Promise((resolve) => {
		worker.on("message", (value: unknown) => {
			if (value && typeof value === "object" && "done" in value) {
				resolve(value as { done: boolean; error?: string });
			}
		});
	});
}

describe("canonical mailbox creation-age retention", () => {
	let directory: string;
	let path: string;
	let db: SqliteDatabase;
	const releases: (() => void)[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		directory = mkdtempSync(join(tmpdir(), "pi-mailbox-retention-"));
		path = join(directory, "control.sqlite");
		listRuntimeMailboxMessages(path);
		db = createSqliteDatabase(path);
	});

	afterEach(() => {
		for (const release of releases.splice(0)) release();
		db.close();
		vi.useRealTimers();
		rmSync(directory, { recursive: true, force: true });
	});

	it("startup deletes every status at the exact boundary and invalid dates, never update age", () => {
		for (const status of ["pending", "claimed", "accepted", "rejected", "delivered", "failed"]) {
			insert(db, status, new Date(now - day).toISOString(), status);
		}
		for (const [index, date] of ["invalid", "", 42].entries()) insert(db, `invalid-${index}`, date);
		insert(db, "fresh", new Date(now - day + 1).toISOString());
		db.prepare("UPDATE multi_agent_mailbox_messages SET updated_at = ? WHERE message_id = 'fresh'").run(
			"2000-01-01T00:00:00.000Z",
		);
		releases.push(retainControlDbConnection(path));
		expect(rows(db)).toEqual(["fresh"]);
	});

	it("startup deletes unknown-age rows from the old schema without repairing them", () => {
		const oldPath = join(directory, "old-control.sqlite");
		const oldDb = createSqliteDatabase(oldPath);
		try {
			oldDb.exec(`CREATE TABLE multi_agent_mailbox_messages (
				session_path TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL,
				updated_at TEXT NOT NULL, PRIMARY KEY (session_path, message_id));
				PRAGMA user_version = 15;`);
			insert(oldDb, "missing", undefined);
			insert(oldDb, "null", null);
			insert(oldDb, "fresh", new Date(now).toISOString());
			releases.push(retainControlDbConnection(oldPath));
			expect(rows(oldDb)).toEqual(["fresh"]);
		} finally {
			oldDb.close();
		}
	});

	it.each([undefined, null])(
		"new API messages default %s birth once and retain it on duplicates and updates",
		(date) => {
			releases.push(retainControlDbConnection(path));
			const input = {
				recipient,
				sender,
				kind: "message" as const,
				storeRef: { sessionPath, messageId: "default-enqueue" },
				message: message("default-enqueue", date),
			};
			const id = enqueueStoredRuntimeMailboxMessage(path, input);
			expect(readRuntimeMailboxMessage(path, id)?.createdAt).toBe(new Date(now).toISOString());
			upsertMultiAgentMailboxMessage(path, sessionPath, "default-upsert", message("default-upsert", date));
			vi.setSystemTime(now + 60_000);
			expect(enqueueStoredRuntimeMailboxMessage(path, input)).toBe(id);
			expect(
				enqueueStoredRuntimeMailboxMessage(path, {
					...input,
					message: message("default-enqueue", date === null ? undefined : null),
				}),
			).toBe(id);
			expect(() =>
				enqueueStoredRuntimeMailboxMessage(path, {
					...input,
					message: message("default-enqueue", new Date(now + 60_000).toISOString()),
				}),
			).toThrow(/collision/i);
			upsertMultiAgentMailboxMessage(path, sessionPath, "default-upsert", {
				...message("default-upsert", date),
				body: "changed body",
				status: "accepted",
			});
			const stored = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE message_id = ?")
				.get("default-upsert") as { data: string };
			expect(JSON.parse(stored.data)).toMatchObject({
				createdAt: new Date(now).toISOString(),
				body: "changed body",
				status: "accepted",
			});
			expect(readRuntimeMailboxMessage(path, id)?.createdAt).toBe(new Date(now).toISOString());
		},
	);

	it("legacy raw inserts default only missing and null births, not supplied invalid or stale dates", () => {
		vi.useRealTimers();
		releases.push(retainControlDbConnection(path));
		const before = Date.now();
		for (const [id, date] of [
			["missing", undefined],
			["null", null],
			["invalid", "invalid"],
			["stale", new Date(before - day).toISOString()],
		] as const)
			insert(db, id, date);
		const after = Date.now();
		for (const id of ["missing", "null"]) {
			const stored = db
				.prepare("SELECT rowid AS id, data FROM multi_agent_mailbox_messages WHERE message_id = ?")
				.get(id) as { id: number; data: string };
			const payload = JSON.parse(stored.data);
			expect(Date.parse(payload.createdAt)).toBeGreaterThanOrEqual(before);
			expect(Date.parse(payload.createdAt)).toBeLessThanOrEqual(after);
			expect(payload).toEqual({ ...message(id, undefined), createdAt: payload.createdAt });
			expect(readRuntimeMailboxMessage(path, stored.id)?.body).toBe(`body ${id}`);
			expect(
				enqueueStoredRuntimeMailboxMessage(path, {
					recipient,
					sender,
					kind: "message",
					storeRef: { sessionPath, messageId: id },
					message: message(id, null),
				}),
			).toBe(stored.id);
		}
		expect(listRuntimeMailboxMessages(path).map((entry) => entry.storeRef.messageId)).toEqual(["missing", "null"]);
		db.prepare(
			"UPDATE multi_agent_mailbox_messages SET data = json_remove(data, '$.createdAt') WHERE message_id = 'missing'",
		).run();
		expect(listRuntimeMailboxMessages(path).map((entry) => entry.storeRef.messageId)).toEqual(["null"]);
	});

	it.each(["invalid", "", new Date(now - day).toISOString()])(
		"supplied %s API dates never default to fresh",
		(date) => {
			expect(() =>
				enqueueStoredRuntimeMailboxMessage(path, {
					recipient,
					sender,
					kind: "message",
					storeRef: { sessionPath, messageId: "invalid" },
					message: message("invalid", date),
				}),
			).toThrow(/expired/i);
			upsertMultiAgentMailboxMessage(path, sessionPath, "invalid", message("invalid", date));
			expect(rows(db)).toEqual([]);
		},
	);

	it("periodic cleanup follows one retained lifetime and stops after the final release", () => {
		const release1 = retainControlDbConnection(path);
		const release2 = retainControlDbConnection(path);
		releases.push(release1, release2);
		insert(db, "periodic", new Date(now - day + 1).toISOString());
		release1();
		vi.advanceTimersByTime(60_000);
		expect(rows(db)).toEqual([]);
		release2();
		release2();
		insert(db, "after-release", new Date(now - day).toISOString());
		vi.advanceTimersByTime(120_000);
		expect(rows(db)).toEqual(["after-release"]);
		releases.push(retainControlDbConnection(path));
		expect(rows(db)).toEqual([]);
	});

	it("one maintenance tick clears a backlog without removing fresh messages", () => {
		releases.push(retainControlDbConnection(path));
		db.exec("BEGIN");
		for (let index = 0; index < 1001; index++) insert(db, `old-${index}`, new Date(now - day).toISOString());
		insert(db, "fresh", new Date(now).toISOString());
		db.exec("COMMIT");
		vi.advanceTimersByTime(60_000);
		expect(rows(db)).toEqual(["fresh"]);
	});

	it("a no-due tick stays read-only while another SQLite connection holds the writer", () => {
		releases.push(retainControlDbConnection(path));
		insert(db, "fresh", new Date(now).toISOString());
		db.exec("BEGIN IMMEDIATE");
		try {
			expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
			expect(rows(db)).toEqual(["fresh"]);
		} finally {
			db.exec("ROLLBACK");
		}
	});

	it("read, restore, claim and direct delivery exclude expired rows during the timer gap", () => {
		releases.push(retainControlDbConnection(path));
		registerRuntimeMailboxListener(path, recipient, process.pid, sessionPath);
		const id = insert(db, "gap", new Date(now - day + 1).toISOString());
		vi.setSystemTime(now + 1);
		expect(readRuntimeMailboxMessage(path, id)).toBeUndefined();
		expect(listRuntimeMailboxMessages(path)).toEqual([]);
		expect(readMultiAgentState(path, sessionPath)).toBeUndefined();
		expect(getMultiAgentMailboxMessageStatus(path, sessionPath, "gap")).toBeUndefined();
		expect(claimRuntimeMailboxMessages(path, recipient)).toEqual([]);
		expect(takeRuntimeMailboxMessagesForDelivery(path, recipient, () => true)).toEqual([]);
		expect(markMultiAgentMailboxMessageDelivered(path, sessionPath, "gap")).toBe(false);
		expect(consumeRuntimeMailboxMessageByStoreRef(path, { sessionPath, messageId: "gap" })).toBe(0);
	});

	it("claim acquired before expiry cannot be delivered after expiry", () => {
		releases.push(retainControlDbConnection(path));
		registerRuntimeMailboxListener(path, recipient, process.pid, sessionPath);
		const id = insert(db, "in-flight", new Date(now - day + 1).toISOString());
		expect(claimRuntimeMailboxMessages(path, recipient)).toHaveLength(1);
		const claimed = readRuntimeMailboxMessageForDelivery(path, id);
		expect(claimed?.payloadValid).toBe(true);
		vi.setSystemTime(now + 1);
		expect(deliverRuntimeMailboxMessage(path, id, claimed?.payloadData)).toBe(false);
		expect(readRuntimeMailboxMessageForDelivery(path, id)).toBeUndefined();
		expect(
			JSON.parse(
				(db.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE rowid = ?").get(id) as { data: string })
					.data,
			).status,
		).toBe("claimed");
	});

	it("expiry during eligibility prevents the in-flight compare-and-swap delivery", () => {
		releases.push(retainControlDbConnection(path));
		registerRuntimeMailboxListener(path, recipient, process.pid, sessionPath);
		insert(db, "eligible", new Date(now - day + 1).toISOString());
		expect(
			takeRuntimeMailboxMessagesForDelivery(path, recipient, () => {
				vi.setSystemTime(now + 1);
				return true;
			}),
		).toEqual([]);
	});

	it("stale upsert cannot reinsert deleted rows or extend their immutable creation time", () => {
		releases.push(retainControlDbConnection(path));
		const fresh = message("stale", new Date(now - day + 1).toISOString());
		upsertMultiAgentMailboxMessage(path, sessionPath, "stale", fresh);
		vi.setSystemTime(now + 1);
		upsertMultiAgentMailboxMessage(path, sessionPath, "stale", {
			...fresh,
			createdAt: new Date(now + 1).toISOString(),
		});
		expect(readMultiAgentState(path, sessionPath)).toBeUndefined();
		vi.advanceTimersByTime(60_000);
		expect(rows(db)).toEqual([]);
		upsertMultiAgentMailboxMessage(path, sessionPath, "stale", fresh);
		expect(rows(db)).toEqual([]);
	});

	it.each(["upsert", "enqueue", "deliver", "status", "consume"] as const)(
		"%s cannot write after expiring while waiting for a real writer lock",
		async (operation) => {
			vi.useRealTimers();
			const createdAt = new Date(Date.now() - day + 1_500).toISOString();
			if (operation !== "enqueue") insert(db, "blocked", createdAt);
			const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/session-control-db.ts")).href;
			const worker = new Worker(
				`
import { parentPort, workerData } from "node:worker_threads";
import { retainControlDbConnection, upsertMultiAgentMailboxMessage, enqueueStoredRuntimeMailboxMessage, registerRuntimeMailboxListener, claimRuntimeMailboxMessages, deliverRuntimeMailboxMessage, markMultiAgentMailboxMessageDelivered, consumeRuntimeMailboxMessageByStoreRef } from ${JSON.stringify(moduleUrl)};
const release = retainControlDbConnection(workerData.path);
let claimed;
if (workerData.operation === "deliver") {
 registerRuntimeMailboxListener(workerData.path, workerData.recipient, process.pid);
 claimed = claimRuntimeMailboxMessages(workerData.path, workerData.recipient)[0];
}
parentPort.postMessage("ready");
parentPort.once("message", () => {
 parentPort.postMessage("prepared");
 try {
  if (workerData.operation === "upsert") upsertMultiAgentMailboxMessage(workerData.path, workerData.sessionPath, "blocked", workerData.message);
  else if (workerData.operation === "enqueue") enqueueStoredRuntimeMailboxMessage(workerData.path, { recipient: workerData.recipient, sender: workerData.sender, kind: "message", storeRef: { sessionPath: workerData.sessionPath, messageId: "blocked" }, message: workerData.message });
  else if (workerData.operation === "deliver") deliverRuntimeMailboxMessage(workerData.path, claimed.id);
  else if (workerData.operation === "status") markMultiAgentMailboxMessageDelivered(workerData.path, workerData.sessionPath, "blocked");
  else consumeRuntimeMailboxMessageByStoreRef(workerData.path, { sessionPath: workerData.sessionPath, messageId: "blocked" });
  parentPort.postMessage({ done: true });
 } catch (error) { parentPort.postMessage({ done: true, error: String(error) }); }
 release();
});`,
				{
					eval: true,
					execArgv: ["--experimental-strip-types"],
					workerData: {
						path,
						sessionPath,
						recipient,
						sender,
						operation,
						message: message("blocked", createdAt, "failed"),
					},
				},
			);
			try {
				await once(worker, "message");
				db.exec("BEGIN IMMEDIATE");
				worker.postMessage("write");
				await once(worker, "message");
				const completion = waitForWorkerCompletion(worker);
				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(0, Date.parse(createdAt) + day - Date.now() + 50)),
				);
				db.exec("ROLLBACK");
				const result = await completion;
				if (operation === "enqueue") expect(result.error).toMatch(/expired/i);
				const row = db
					.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE message_id = 'blocked'")
					.get() as { data: string } | undefined;
				if (operation === "enqueue") expect(row).toBeUndefined();
				else expect(JSON.parse(row?.data ?? "null").status).toBe(operation === "deliver" ? "claimed" : "pending");
			} finally {
				await worker.terminate();
			}
		},
	);

	it("shared pure expiry helper uses creation age, exact milliseconds and invalid dates", () => {
		expect(MAILBOX_MESSAGE_RETENTION_MS).toBe(day);
		for (const date of [undefined, null, 42, "", "invalid", new Date(now)]) {
			expect(isMailboxMessageExpired(date, now)).toBe(true);
		}
		expect(isMailboxMessageExpired(new Date(now - day).toISOString(), now)).toBe(true);
		expect(isMailboxMessageExpired(new Date(now - day + 1).toISOString(), now)).toBe(false);
		expect(isMailboxMessageExpired(new Date(now + 1).toISOString(), now)).toBe(false);
		expect(isMailboxMessageExpired("2026-10-07T14:00:00.001+02:00", now)).toBe(false);
	});

	it.runIf(hasBun)("Bun startup uses exact expiry milliseconds and an unref timer permits process exit", () => {
		insert(db, "expired", "2026-10-07T14:00:00.000+02:00");
		insert(db, "fresh", "2026-10-07T14:00:00.001+02:00");
		const scriptPath = join(directory, "bun-retention.ts");
		const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/session-control-db.ts")).href;
		writeFileSync(
			scriptPath,
			`import { retainControlDbConnection, listRuntimeMailboxMessages } from ${JSON.stringify(moduleUrl)};
Date.now = () => ${now};
retainControlDbConnection(process.argv[2]);
console.log(JSON.stringify(listRuntimeMailboxMessages(process.argv[2]).map(message => message.storeRef.messageId)));
`,
		);
		const result = spawnSync("bun", [scriptPath, path], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(["fresh"]);
		expect(rows(db)).toEqual(["fresh"]);
	});

	it("old numeric enqueue rejects without inserting or returning a fabricated ID", () => {
		expect(() =>
			enqueueStoredRuntimeMailboxMessage(path, {
				recipient,
				sender,
				kind: "message",
				storeRef: { sessionPath, messageId: "old" },
				message: message("old", new Date(now - day).toISOString()),
			}),
		).toThrow(/expired/i);
		expect(rows(db)).toEqual([]);
	});
});

it("a live legacy SQL producer survives parent restart and exchanges fresh messages with the new API", async () => {
	await withHeadlessPi(async (agent) => {
		const startedPath = join(agent.paths.workspaceDir, "legacy-started");
		const releasePath = join(agent.paths.workspaceDir, "legacy-write");
		const donePath = join(agent.paths.workspaceDir, "legacy-done");
		const controlDbPath = getControlDbPath(agent.paths.agentDir);
		const legacyMessage = message("legacy-restart", undefined);
		const code = [
			"from pathlib import Path",
			"import sqlite3, time",
			`db = sqlite3.connect(${JSON.stringify(controlDbPath)}, timeout=10)`,
			`started = Path(${JSON.stringify(startedPath)})`,
			`release = Path(${JSON.stringify(releasePath)})`,
			`done = Path(${JSON.stringify(donePath)})`,
			'started.write_text((started.read_text() if started.exists() else "") + "x")',
			"while not release.exists(): time.sleep(0.05)",
			`db.execute("INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at) VALUES (?, ?, ?, ?)", (${JSON.stringify(agent.sessionFile)}, "legacy-restart", ${JSON.stringify(JSON.stringify(legacyMessage))}, "2000-01-01T00:00:00.000Z"))`,
			"db.commit()",
			"while not done.exists(): time.sleep(0.05)",
			"db.close()",
		].join("\n");
		await agent.send({ type: "prompt", message: "Run the legacy SQL producer" });
		const initial = await agent.waitForLlmRequest((request) => request.agentId === null);
		agent.respondToLlmRequest(
			initial.id,
			fauxAssistantMessage(fauxToolCall("pyrun_eval", { code }), { stopReason: "toolUse" }),
		);
		await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 30_000 });
		const runnerPids = agent.getPyrunRunnerPids();
		expect(runnerPids.length).toBeGreaterThan(0);
		void agent.send({ type: "prompt", message: "/restart" }).catch(() => undefined);
		const restored = await agent.waitForLlmRequest(
			(request) =>
				request.agentId === null && JSON.stringify(request.messages).includes("The agent process was restarted"),
		);
		const job = await agent.waitForAgent(
			(candidate) => candidate.displayName === "Pyrun evaluation" && candidate.lifecycle === "running",
		);
		expect(restored.messages.filter((entry) => entry.role === "toolResult")).toMatchObject([
			{ isError: false, details: { backgroundJobId: job.id } },
		]);
		expect(agent.getPyrunRunnerPids()).toEqual(runnerPids);
		agent.respondToLlmRequest(
			restored.id,
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Wait for legacy producer" }), {
				stopReason: "toolUse",
			}),
		);
		registerRuntimeMailboxListener(controlDbPath, recipient, process.pid);
		const before = Date.now();
		writeFileSync(releasePath, "write");
		await vi.waitFor(
			() =>
				expect(
					listRuntimeMailboxMessages(controlDbPath).some((entry) => entry.storeRef.messageId === "legacy-restart"),
				).toBe(true),
			{ timeout: 10_000 },
		);
		enqueueStoredRuntimeMailboxMessage(controlDbPath, {
			recipient,
			sender,
			kind: "message",
			storeRef: { sessionPath: agent.sessionFile, messageId: "new-restart" },
			message: message("new-restart", null),
		});
		const received = claimRuntimeMailboxMessages(controlDbPath, recipient);
		expect(received.map((entry) => entry.storeRef.messageId)).toEqual(["legacy-restart", "new-restart"]);
		for (const entry of received) {
			expect(Date.parse(entry.createdAt)).toBeGreaterThanOrEqual(before);
			expect(Date.parse(entry.createdAt)).toBeLessThanOrEqual(Date.now());
			expect(entry.body).toBe(`body ${entry.storeRef.messageId}`);
		}
		expect(readFileSync(startedPath, "utf8")).toBe("x");
		writeFileSync(donePath, "done");
		await agent.waitForAgent((candidate) => candidate.id === job.id && candidate.lifecycle === "completed");
	});
}, 90_000);
