import { MAILBOX_MESSAGE_RETENTION_MS } from "./mailbox-retention.ts";
import {
	enqueueStoredRuntimeMailboxMessageInTransaction,
	notifyRuntimeMailboxRecipient,
	type RuntimeMailboxMessageKind,
	withControlDb,
	withImmediateTransaction,
} from "./session-control-db.ts";
import type { SqliteDatabase } from "./sqlite.ts";

export interface RelayMailbox {
	type: "mailbox";
	seq: number;
	sessionPath: string;
	messageId: string;
	data: Record<string, unknown>;
}
export interface RelayChannel {
	type: "channel";
	originHost: string;
	originId: number;
	senderSessionId: string;
	senderAgentId: string | null;
	body: string;
	createdAt: string;
}

function readCounter(db: SqliteDatabase, key: string): number {
	return (
		(
			db
				.prepare("SELECT last_seen_id FROM shared_channel_cursors WHERE session_id = ? AND agent_id_key = ''")
				.get(key) as { last_seen_id: number } | undefined
		)?.last_seen_id ?? 0
	);
}
function writeCounter(db: SqliteDatabase, key: string, value: number): void {
	db.prepare(`INSERT INTO shared_channel_cursors(session_id, agent_id_key, last_seen_id, updated_at) VALUES (?, '', ?, ?)
 ON CONFLICT(session_id, agent_id_key) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id), updated_at = excluded.updated_at`).run(
		key,
		value,
		new Date().toISOString(),
	);
}

/** Stop-and-wait: the smallest stored sequence is retried until acknowledged or expired. */
export function nextRelayMailbox(path: string, peer: string): RelayMailbox | undefined {
	return withControlDb(path, (db) =>
		withImmediateTransaction(db, () => {
			const row = db
				.prepare(`SELECT session_path, message_id, data FROM multi_agent_mailbox_messages
   WHERE json_valid(data) AND json_extract(data, '$.recipientHost') = ? AND json_extract(data, '$.status') = 'pending'
   AND json_type(data, '$.createdAt') = 'text'
   AND CAST(ROUND((julianday(json_extract(data, '$.createdAt')) - 2440587.5) * 86400000) AS INTEGER) > ?
   ORDER BY json_extract(data, '$.relaySeq') IS NULL, json_extract(data, '$.relaySeq'), rowid LIMIT 1`)
				.get(peer, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as
				| { session_path: string; message_id: string; data: string }
				| undefined;
			if (!row) return undefined;
			const data: Record<string, unknown> = JSON.parse(row.data);
			let seq = data.relaySeq;
			if (seq === undefined) {
				seq = readCounter(db, `relay-out:${peer}`) + 1;
				if (!Number.isSafeInteger(seq)) throw new Error(`Relay sequence exhausted for ${peer}`);
				data.relaySeq = seq;
				db.prepare(
					"UPDATE multi_agent_mailbox_messages SET data = ? WHERE session_path = ? AND message_id = ? AND data = ?",
				).run(JSON.stringify(data), row.session_path, row.message_id, row.data);
				writeCounter(db, `relay-out:${peer}`, seq as number);
			}
			if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)
				throw new Error(`Invalid stored relay sequence for ${peer}`);
			return { type: "mailbox", seq, sessionPath: row.session_path, messageId: row.message_id, data };
		}),
	);
}

export function ackRelayMailbox(path: string, peer: string, message: RelayMailbox): void {
	withControlDb(path, (db) => {
		db.prepare(`DELETE FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ? AND data = ?
   AND json_extract(data, '$.recipientHost') = ? AND json_extract(data, '$.relaySeq') = ?`).run(
			message.sessionPath,
			message.messageId,
			JSON.stringify(message.data),
			peer,
			message.seq,
		);
	});
}

export function importRelayMailbox(path: string, peer: string, message: RelayMailbox): void {
	const data = { ...message.data };
	delete data.recipientHost;
	delete data.relaySeq;
	const recipient = {
		sessionId: requireText(data.recipientSessionId, "recipientSessionId"),
		agentId: nullableText(data.recipientAgentId, "recipientAgentId"),
	};
	const sender = {
		sessionId: requireText(data.senderSessionId, "senderSessionId"),
		agentId: nullableText(data.senderAgentId, "senderAgentId"),
	};
	const applied = withControlDb(path, (db) =>
		withImmediateTransaction(db, () => {
			if (message.seq <= readCounter(db, `relay-in:${peer}`)) return false;
			enqueueStoredRuntimeMailboxMessageInTransaction(db, {
				kind: requireText(data.kind, "kind") as RuntimeMailboxMessageKind,
				recipient,
				sender,
				storeRef: { sessionPath: message.sessionPath, messageId: message.messageId },
				message: data,
			});
			writeCounter(db, `relay-in:${peer}`, message.seq);
			return true;
		}),
	);
	if (applied) notifyRuntimeMailboxRecipient(path, recipient);
}

/** A new peer starts at the current tail; existing history is not broadcast as new. */
function relayChannelCursor(db: SqliteDatabase, peer: string): number {
	const key = `relay:${peer}`;
	const existing = db
		.prepare("SELECT last_seen_id FROM shared_channel_cursors WHERE session_id = ? AND agent_id_key = ''")
		.get(key) as { last_seen_id: number } | undefined;
	if (existing) return existing.last_seen_id;
	const tail =
		(db.prepare("SELECT MAX(id) AS tail FROM shared_channel_messages").get() as { tail: number | null }).tail ?? 0;
	writeCounter(db, key, tail);
	return tail;
}

export function nextRelayChannel(path: string, peer: string, host: string): RelayChannel | undefined {
	return withControlDb(path, (db) => {
		const row = db
			.prepare(`SELECT id, sender_session_id, sender_agent_id, body, created_at FROM shared_channel_messages
   WHERE origin_host IS NULL AND id > ? ORDER BY id LIMIT 1`)
			.get(relayChannelCursor(db, peer)) as
			| { id: number; sender_session_id: string; sender_agent_id: string | null; body: string; created_at: string }
			| undefined;
		return row
			? {
					type: "channel",
					originHost: host,
					originId: row.id,
					senderSessionId: row.sender_session_id,
					senderAgentId: row.sender_agent_id,
					body: row.body,
					createdAt: row.created_at,
				}
			: undefined;
	});
}
export function ackRelayChannel(path: string, peer: string, id: number): void {
	withControlDb(path, (db) => writeCounter(db, `relay:${peer}`, id));
}
export function importRelayChannel(path: string, message: RelayChannel): void {
	const recipients = withControlDb(path, (db) => {
		const result = db
			.prepare(`INSERT INTO shared_channel_messages(sender_session_id, sender_agent_id, body, created_at, origin_host, origin_id)
   VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
			.run(
				message.senderSessionId,
				message.senderAgentId,
				message.body,
				message.createdAt,
				message.originHost,
				message.originId,
			);
		if (!result.changes) return [];
		return db
			.prepare("SELECT recipient_session_id FROM runtime_mailbox_listeners WHERE recipient_agent_id_key = ''")
			.all() as { recipient_session_id: string }[];
	});
	for (const recipient of recipients)
		notifyRuntimeMailboxRecipient(path, { sessionId: recipient.recipient_session_id, agentId: null });
}

export function requireText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid relay ${field}`);
	return value;
}
export function nullableText(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireText(value, field);
}
