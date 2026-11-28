import { describeSession, lookupSessionNames } from "../supervisor/inspect-session.ts";
import { answerSessionInspectionRequest, isSessionInspectionRequest } from "../supervisor/mail.ts";
import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "./mailbox-retention.ts";
import { recordUserQuestionAnswer } from "./session-control-db/user-questions.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessageInTransaction,
	notifyRuntimeMailboxRecipient,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessageKind,
	readLiveRuntimeMailboxSessionAgentIds,
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
/** A hub link end: the hub forwards between spokes; a spoke reaches every other host through the hub. */
export type RelayRole = "hub" | "spoke";

export interface RelayChannel {
	type: "channel";
	originHost: string;
	originId: number;
	senderSessionId: string;
	senderAgentId: string | null;
	body: string;
	createdAt: string;
	/** This host's row ID: the peer's cursor once acknowledged. Not sent. */
	cursor: number;
}
/** A channel entry as sent: without this host's cursor. */
export type RelayChannelFrame = Omit<RelayChannel, "cursor">;

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

/**
 * Stop-and-wait: the smallest stored sequence is retried until acknowledged or expired. The hub sends a spoke
 * the messages for it; a spoke (given `spokeHost`, its own host) sends the hub every message for another host.
 */
export function nextRelayMailbox(path: string, peer: string, spokeHost?: string): RelayMailbox | undefined {
	return withControlDb(path, (db) =>
		withImmediateTransaction(db, () => {
			const row = db
				.prepare(`SELECT session_path, message_id, data FROM multi_agent_mailbox_messages
   WHERE json_valid(data) AND json_extract(data, '$.status') = 'pending'
   AND (CASE WHEN ? IS NULL THEN json_extract(data, '$.recipientHost') = ?
        ELSE json_extract(data, '$.recipientHost') IS NOT NULL AND json_extract(data, '$.recipientHost') != ? END)
   AND json_type(data, '$.createdAt') = 'text'
   AND CAST(ROUND((julianday(json_extract(data, '$.createdAt')) - 2440587.5) * 86400000) AS INTEGER) > ?
   ORDER BY json_extract(data, '$.relaySeq') IS NULL, json_extract(data, '$.relaySeq'), rowid LIMIT 1`)
				.get(spokeHost ?? null, peer, spokeHost ?? null, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as
				| { session_path: string; message_id: string; data: string }
				| undefined;
			if (!row) return undefined;
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.data);
			} catch {
				throw new Error(`Invalid stored relay mailbox JSON for ${peer}`);
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error(`Invalid stored relay mailbox data for ${peer}`);
			}
			const data = parsed as Record<string, unknown>;
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

export function ackRelayMailbox(path: string, message: RelayMailbox): void {
	withControlDb(path, (db) => {
		db.prepare(`DELETE FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ? AND data = ?
   AND json_extract(data, '$.relaySeq') = ?`).run(
			message.sessionPath,
			message.messageId,
			JSON.stringify(message.data),
			message.seq,
		);
	});
}

export function importRelayMailbox(path: string, peer: string, message: RelayMailbox, host: string): void {
	const data = { ...message.data };
	delete data.relaySeq;
	// Set by the hub when it forwards between spokes; the origin host is where replies go.
	data.senderHost = typeof data.senderHost === "string" ? data.senderHost : peer;
	if (data.recipientHost !== host) {
		forwardRelayMailbox(path, peer, message, data);
		return;
	}
	delete data.recipientHost;
	const senderHost = data.senderHost as string;
	const recipient = {
		sessionId: requireText(data.recipientSessionId, "recipientSessionId"),
		agentId: nullableText(data.recipientAgentId, "recipientAgentId"),
	};
	const sender = {
		sessionId: requireText(data.senderSessionId, "senderSessionId"),
		agentId: nullableText(data.senderAgentId, "senderAgentId"),
	};
	const inspection = isSessionInspectionRequest(message.messageId);
	if (message.messageId.startsWith("user_question_answer:")) {
		const alreadyImported = withControlDb(path, (db) => message.seq <= readCounter(db, `relay-in:${peer}`));
		if (alreadyImported) return;
		let answer: unknown;
		try {
			answer = JSON.parse(requireText(data.body, "body"));
		} catch (error) {
			throw new Error("Invalid relayed user-question answer", { cause: error });
		}
		if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
			throw new Error("Invalid relayed user-question answer");
		}
		const payload = answer as { id?: unknown; answer?: unknown };
		if (typeof payload.id !== "number" || typeof payload.answer !== "string" || !payload.answer.trim()) {
			throw new Error("Invalid relayed user-question answer");
		}
		if (!recordUserQuestionAnswer(path, payload.id, payload.answer)) {
			// The question expired from the three-day store; the answer has nowhere to go.
			console.error(`Dropped relayed answer from ${peer} to unknown user question ${payload.id}`);
		}
		withControlDb(path, (db) => writeCounter(db, `relay-in:${peer}`, message.seq));
		return;
	}
	const applied = withControlDb(path, (db) =>
		withImmediateTransaction(db, () => {
			if (message.seq <= readCounter(db, `relay-in:${peer}`)) return false;
			// Expiry is a permitted sequence gap: drop the row (and leave an expired inspection unanswered) so the ack
			// moves the peer on to fresh mail.
			const expired = isMailboxMessageExpired(data.createdAt, Date.now());
			if (inspection || expired) {
				writeCounter(db, `relay-in:${peer}`, message.seq);
				return inspection && !expired;
			}
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
	if (!applied) return;
	if (inspection) {
		// The relay answers on the session's host, so a busy or stopped session can still be inspected.
		answerSessionInspectionRequest(
			path,
			senderHost,
			data,
			(sessionId) => describeSession(path, sessionId),
			(sessionIds) => lookupSessionNames(path, sessionIds),
		);
		return;
	}
	notifyRuntimeMailboxRecipient(path, recipient);
	// The relay acknowledges on import, so the sender would otherwise only see "queued" while the message waits.
	// Notices are system messages and are never answered with another notice. A reply answers the recipient's own
	// request, so its sender has nothing to act on; a Supervisor reads reply-prefixed mail as JSON.
	if (
		data.kind !== "system" &&
		data.kind !== "reply" &&
		!readLiveRuntimeMailboxSessionAgentIds(path, recipient.sessionId).includes(recipient.agentId)
	)
		queueNotRunningNotice(path, senderHost, host, message, recipient, sender, String(data.body ?? ""));
}

/**
 * On the hub: keep a message for another spoke queued for that spoke's link. Its store key names the origin
 * host, so it cannot collide with a hub session's own message.
 */
function forwardRelayMailbox(path: string, peer: string, message: RelayMailbox, data: Record<string, unknown>): void {
	const recipientHost = requireText(data.recipientHost, "recipientHost");
	withControlDb(path, (db) =>
		withImmediateTransaction(db, () => {
			if (message.seq <= readCounter(db, `relay-in:${peer}`)) return;
			if (!isMailboxMessageExpired(data.createdAt, Date.now()))
				enqueueStoredRuntimeMailboxMessageInTransaction(db, {
					kind: requireText(data.kind, "kind") as RuntimeMailboxMessageKind,
					recipientHost,
					recipient: {
						sessionId: requireText(data.recipientSessionId, "recipientSessionId"),
						agentId: nullableText(data.recipientAgentId, "recipientAgentId"),
					},
					sender: {
						sessionId: requireText(data.senderSessionId, "senderSessionId"),
						agentId: nullableText(data.senderAgentId, "senderAgentId"),
					},
					storeRef: {
						sessionPath: `relay:${String(data.senderHost)}:${message.sessionPath}`,
						messageId: message.messageId,
					},
					message: data,
				});
			writeCounter(db, `relay-in:${peer}`, message.seq);
		}),
	);
}

function queueNotRunningNotice(
	path: string,
	senderHost: string,
	host: string,
	message: RelayMailbox,
	recipient: RuntimeMailboxAddress,
	sender: RuntimeMailboxAddress,
	body: string,
): void {
	const id = `${message.messageId}-not-running`;
	const excerpt = body.split("\n")[0]?.slice(0, 120) ?? "";
	const session = recipient.agentId
		? `agent ${recipient.agentId} in session ${recipient.sessionId}`
		: `session ${recipient.sessionId}`;
	enqueueStoredRuntimeMailboxMessage(path, {
		kind: "system",
		recipientHost: senderHost,
		recipient: sender,
		sender: recipient,
		// Message IDs are per sender session, so the sender's session path keeps two senders' notices apart.
		storeRef: { sessionPath: `relay:${senderHost}:${message.sessionPath}`, messageId: id },
		message: {
			id,
			kind: "system",
			status: "pending",
			fromAgentId: recipient.agentId ?? "main",
			toAgentId: sender.agentId ?? "main",
			body: `Not delivered yet: ${session} on host ${host} is not running. "${excerpt}" stays queued for up to 24 hours until that session runs.`,
			createdAt: new Date().toISOString(),
		},
	});
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

/** A spoke sends its own posts; the hub also sends a spoke every post another spoke sent it. */
export function nextRelayChannel(path: string, peer: string, host: string, role: RelayRole): RelayChannel | undefined {
	return withControlDb(path, (db) => {
		const row = db
			.prepare(`SELECT id, sender_session_id, sender_agent_id, body, created_at, origin_host, origin_id
   FROM shared_channel_messages
   WHERE (origin_host IS NULL OR (? = 'hub' AND origin_host != ?)) AND id > ? ORDER BY id LIMIT 1`)
			.get(role, peer, relayChannelCursor(db, peer)) as
			| {
					id: number;
					sender_session_id: string;
					sender_agent_id: string | null;
					body: string;
					created_at: string;
					origin_host: string | null;
					origin_id: number | null;
			  }
			| undefined;
		return row
			? {
					type: "channel",
					originHost: row.origin_host ?? host,
					originId: row.origin_id ?? row.id,
					cursor: row.id,
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
export function importRelayChannel(path: string, message: RelayChannelFrame): void {
	// Expiry deletes the (origin_host, origin_id) dedup row; a late retry must not resurrect it.
	if (isMailboxMessageExpired(message.createdAt, Date.now())) return;
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
