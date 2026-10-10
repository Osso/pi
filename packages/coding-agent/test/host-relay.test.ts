import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHostRelay } from "../src/core/host-relay.ts";
import { ackRelayMailbox, importRelayMailbox, nextRelayMailbox } from "../src/core/host-relay-store.ts";
import {
	claimRuntimeMailboxMessages,
	consumeRuntimeMailboxMessageByStoreRef,
	enqueueStoredRuntimeMailboxMessage,
	listSharedChannelMessagesAfter,
	markRuntimeMailboxMessageDelivered,
	postSharedChannelMessage,
	registerRuntimeMailboxListener,
	takeRuntimeMailboxMessagesForDelivery,
	withControlDb,
} from "../src/core/session-control-db.ts";

const a = { sessionId: "laptop-session", agentId: null };
const b = { sessionId: "server-session", agentId: null };

describe("cross-host relay", () => {
	let directory: string;
	let dbA: string;
	let dbB: string;
	const stops: (() => void)[] = [];
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-relay-"));
		dbA = join(directory, "a.sqlite");
		dbB = join(directory, "b.sqlite");
		registerRuntimeMailboxListener(dbA, a, process.pid);
		registerRuntimeMailboxListener(dbB, b, process.pid);
	});
	afterEach(async () => {
		for (const stop of stops.splice(0)) stop();
		await new Promise((resolve) => setTimeout(resolve, 20));
		rmSync(directory, { recursive: true, force: true });
	});
	function queue(db: string, host: string, id: string, body: string, reverse = false) {
		return enqueueStoredRuntimeMailboxMessage(db, {
			kind: "message",
			recipient: reverse ? a : b,
			sender: reverse ? b : a,
			recipientHost: host,
			storeRef: { sessionPath: reverse ? "/server/session.jsonl" : "/laptop/session.jsonl", messageId: id },
			message: {
				id,
				kind: "message",
				status: "pending",
				fromAgentId: "main",
				toAgentId: "main",
				body,
				createdAt: new Date().toISOString(),
			},
		});
	}
	function count(db: string) {
		return withControlDb(
			db,
			(sql) => (sql.prepare("SELECT COUNT(*) AS n FROM multi_agent_mailbox_messages").get() as { n: number }).n,
		);
	}
	function connect(dropAcks = false) {
		const ab = new PassThrough();
		const ba = new Transform({
			transform(chunk, _encoding, callback) {
				const line = chunk.toString();
				callback(null, dropAcks && line.includes('"type":"ack"') ? undefined : chunk);
			},
		});
		const controller = new AbortController();
		stops.push(() => controller.abort());
		const done = Promise.all([
			runHostRelay({
				controlDbPath: dbA,
				host: "aso",
				input: ba,
				output: ab,
				pollMs: 20,
				signal: controller.signal,
			}),
			runHostRelay({
				controlDbPath: dbB,
				host: "agent-server",
				input: ab,
				output: ba,
				pollMs: 20,
				signal: controller.signal,
			}),
		]);
		return { done, stop: () => controller.abort() };
	}
	it("forwards both ways and imports channels once across reconnect", async () => {
		queue(dbA, "agent-server", "first", "from laptop");
		postSharedChannelMessage(dbA, { sender: a, body: "Restart /tmp/shared" });
		const first = connect();
		await expect.poll(() => count(dbB)).toBe(1);
		await expect.poll(() => count(dbA)).toBe(0);
		expect(takeRuntimeMailboxMessagesForDelivery(dbB, b, () => true).map((m) => m.body)).toEqual(["from laptop"]);
		await expect
			.poll(() => listSharedChannelMessagesAfter(dbB, 0))
			.toMatchObject([{ originHost: "aso", body: "Restart /tmp/shared" }]);
		queue(dbB, "aso", "reply", "from server", true);
		await expect.poll(() => count(dbA)).toBe(1);
		expect(takeRuntimeMailboxMessagesForDelivery(dbA, a, () => true).map((m) => m.body)).toEqual(["from server"]);
		first.stop();
		await first.done;
		withControlDb(dbA, (sql) => {
			sql.prepare("DELETE FROM shared_channel_cursors WHERE session_id = ?").run("relay:agent-server");
		});
		const second = connect();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(listSharedChannelMessagesAfter(dbB, 0)).toHaveLength(1);
		second.stop();
		await second.done;
	});
	it("keeps remote rows pending during outage without blocking local delivery", async () => {
		queue(dbA, "agent-server", "remote", "remote pending");
		enqueueStoredRuntimeMailboxMessage(dbA, {
			kind: "message",
			recipient: a,
			sender: a,
			storeRef: { sessionPath: "/local", messageId: "local" },
			message: {
				id: "local",
				kind: "message",
				status: "pending",
				fromAgentId: "main",
				toAgentId: "main",
				body: "local works",
				createdAt: new Date().toISOString(),
			},
		});
		// Even a colliding recipient ID must not claim a foreign-host row.
		registerRuntimeMailboxListener(dbA, b, process.pid);
		expect(takeRuntimeMailboxMessagesForDelivery(dbA, b, () => true)).toEqual([]);
		registerRuntimeMailboxListener(dbA, a, process.pid);
		expect(takeRuntimeMailboxMessagesForDelivery(dbA, a, () => true).map((m) => m.body)).toEqual(["local works"]);
		expect(count(dbA)).toBe(1);
		const connection = connect();
		await expect.poll(() => count(dbB)).toBe(1);
		await expect.poll(() => count(dbA)).toBe(0);
		connection.stop();
		await connection.done;
	});
	it("persists sequences and forwards strictly in order with fixed cursor storage", () => {
		for (const id of ["one", "two", "three"]) queue(dbA, "agent-server", id, id);
		for (const [index, id] of ["one", "two", "three"].entries()) {
			const message = nextRelayMailbox(dbA, "agent-server");
			if (!message) throw new Error("Expected queued relay message");
			expect(message.messageId).toBe(id);
			expect(message.seq).toBe(index + 1);
			expect(nextRelayMailbox(dbA, "agent-server")).toEqual(message);
			importRelayMailbox(dbB, "aso", message);
			expect(takeRuntimeMailboxMessagesForDelivery(dbB, b, () => true).map((item) => item.body)).toEqual([id]);
			importRelayMailbox(dbB, "aso", message);
			expect(count(dbB)).toBe(0);
			ackRelayMailbox(dbA, "agent-server", message);
		}
		expect(count(dbA)).toBe(0);
		expect(
			withControlDb(dbA, (sql) => sql.prepare("SELECT session_id, last_seen_id FROM shared_channel_cursors").all()),
		).toEqual([{ session_id: "relay-out:agent-server", last_seen_id: 3 }]);
		expect(
			withControlDb(dbB, (sql) => sql.prepare("SELECT session_id, last_seen_id FROM shared_channel_cursors").all()),
		).toEqual([{ session_id: "relay-in:aso", last_seen_id: 3 }]);
	});
	it("rolls back the inbound high-water mark when import fails", () => {
		queue(dbA, "agent-server", "atomic", "first payload");
		const first = nextRelayMailbox(dbA, "agent-server");
		if (!first) throw new Error("Expected relay payload");
		importRelayMailbox(dbB, "aso", first);
		const conflict = { ...first, seq: 2, data: { ...first.data, body: "conflicting payload" } };
		expect(() => importRelayMailbox(dbB, "aso", conflict)).toThrow("collision");
		expect(
			withControlDb(dbB, (sql) =>
				sql.prepare("SELECT last_seen_id FROM shared_channel_cursors WHERE session_id = 'relay-in:aso'").get(),
			),
		).toEqual({ last_seen_id: 1 });
		const next = {
			...first,
			seq: 2,
			messageId: "after-conflict",
			data: { ...first.data, id: "after-conflict", body: "after conflict" },
		};
		importRelayMailbox(dbB, "aso", next);
		expect(takeRuntimeMailboxMessagesForDelivery(dbB, b, () => true).map((message) => message.body)).toEqual([
			"first payload",
			"after conflict",
		]);
	});

	it("rejects local claims and direct delivery deletion for foreign-host rows", () => {
		const id = queue(dbA, "agent-server", "foreign", "foreign row");
		registerRuntimeMailboxListener(dbA, b, process.pid);
		expect(claimRuntimeMailboxMessages(dbA, b)).toEqual([]);
		expect(
			consumeRuntimeMailboxMessageByStoreRef(dbA, { sessionPath: "/laptop/session.jsonl", messageId: "foreign" }),
		).toBe(0);
		markRuntimeMailboxMessageDelivered(dbA, id);
		expect(count(dbA)).toBe(1);
	});
	it("does not redeliver after receiver deletion and lost ack, including reconnect", async () => {
		queue(dbA, "agent-server", "lost-ack", "once only");
		const first = connect(true);
		await expect.poll(() => count(dbB)).toBe(1);
		expect(takeRuntimeMailboxMessagesForDelivery(dbB, b, () => true)).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(count(dbB)).toBe(0);
		expect(count(dbA)).toBe(1);
		first.stop();
		await first.done;
		const second = connect();
		await expect.poll(() => count(dbA)).toBe(0);
		expect(takeRuntimeMailboxMessagesForDelivery(dbB, b, () => true)).toEqual([]);
		queue(dbA, "agent-server", "next", "next sequence");
		await expect.poll(() => count(dbB)).toBe(1);
		expect(takeRuntimeMailboxMessagesForDelivery(dbB, b, () => true).map((m) => m.body)).toEqual(["next sequence"]);
		expect(
			withControlDb(
				dbB,
				(sql) =>
					(
						sql
							.prepare("SELECT COUNT(*) AS n FROM shared_channel_cursors WHERE session_id = 'relay-in:aso'")
							.get() as { n: number }
					).n,
			),
		).toBe(1);
		second.stop();
		await second.done;
	});
});
