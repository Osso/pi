import { hostname } from "node:os";
import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseJsonObject, parseStoredJsonObject, requireStringField, validateMailboxPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import {
	compareAndDeleteCanonicalMailboxPayload,
	compareAndWriteSerializedCanonicalMailboxPayload,
	parseCanonicalMailboxPayload,
	readCanonicalMailboxRowByStoreRef,
	sameMailboxMessageIdentity,
} from "./runtime-mailbox-enqueue.ts";
import { MAILBOX_CREATED_AT_MS_SQL, type RuntimeMailboxStoreRef } from "./types.ts";

export function consumeRuntimeMailboxMessageByStoreRef(
	controlDbPath: string,
	storeRef: RuntimeMailboxStoreRef,
): number {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowByStoreRef(db, storeRef);
		if (!row) return 0;
		const host = parseCanonicalMailboxPayload(row).recipientHost;
		if (host && host !== hostname()) return 0;
		return Number(withImmediateTransaction(db, () => compareAndDeleteCanonicalMailboxPayload(db, row)));
	});
}

export const MULTI_AGENT_MAILBOX_UPSERT_MAX_ATTEMPTS = 3;

export type ParentRequestTargetSnapshot = {
	agentId: string;
	data: string;
};

export type MultiAgentMailboxRowSnapshot = {
	data: string;
	updated_at: string;
};

export type MultiAgentMailboxUpsertPlan = {
	existing: MultiAgentMailboxRowSnapshot | undefined;
	parentTarget: ParentRequestTargetSnapshot | undefined;
	serialized: string;
};

export function upsertMultiAgentMailboxMessage(
	controlDbPath: string,
	sessionPath: string,
	id: string,
	data: unknown,
): void {
	validateMailboxPayload(data, `multi_agent_mailbox_messages:${sessionPath}#${id}`);
	const createdAt = (data as Record<string, unknown>).createdAt;
	if (createdAt != null && isMailboxMessageExpired(createdAt, Date.now())) return;
	withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_MAILBOX_UPSERT_MAX_ATTEMPTS; attempt += 1) {
			const plan = prepareMultiAgentMailboxUpsert(db, sessionPath, id, data);
			if (
				isMailboxMessageExpired(
					parseStoredJsonObject(plan.serialized, `${sessionPath}#${id}`).createdAt,
					Date.now(),
				)
			)
				return;
			if (plan.existing?.data === plan.serialized) return;
			if (commitMultiAgentMailboxUpsert(db, sessionPath, id, plan)) return;
		}
		throw new Error(`Mailbox message changed repeatedly while updating ${sessionPath}#${id}`);
	});
}

export function prepareMultiAgentMailboxUpsert(
	db: SqliteDatabase,
	sessionPath: string,
	id: string,
	data: unknown,
): MultiAgentMailboxUpsertPlan {
	const parentTarget = readParentRequestTargetSnapshot(db, sessionPath, data);
	const existing = readMultiAgentMailboxRowSnapshot(db, sessionPath, id);
	let serialized = JSON.stringify(data);
	if (existing) {
		const previous = parseJsonObject(existing.data);
		const next = parseJsonObject(serialized);
		if (!previous || !next || !sameMailboxMessageIdentity(previous, next, id)) {
			throw new Error(`Mailbox message ID collision: ${sessionPath}#${id}`);
		}
		serialized = JSON.stringify(mergeCanonicalMailboxUpdate(previous, next));
	} else if ((data as Record<string, unknown>).createdAt == null) {
		serialized = JSON.stringify({ ...(data as Record<string, unknown>), createdAt: new Date().toISOString() });
	}
	return { existing, parentTarget, serialized };
}

export function commitMultiAgentMailboxUpsert(
	db: SqliteDatabase,
	sessionPath: string,
	id: string,
	plan: MultiAgentMailboxUpsertPlan,
): boolean {
	const createdAt = parseStoredJsonObject(plan.serialized, `${sessionPath}#${id}`).createdAt;
	const hasParentTarget = plan.parentTarget ? 1 : 0;
	const hasExisting = plan.existing ? 1 : 0;
	return withImmediateTransaction(db, () => {
		if (isMailboxMessageExpired(createdAt, Date.now())) return true;
		return (
			db
				.prepare(
					`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 SELECT ?, ?, ?, ?
				 WHERE (? = 0 OR EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				 ))
				 AND ((? = 0 AND NOT EXISTS (
					SELECT 1 FROM multi_agent_mailbox_messages
					WHERE session_path = ? AND message_id = ?
				 )) OR (? = 1 AND EXISTS (
					SELECT 1 FROM multi_agent_mailbox_messages
					WHERE session_path = ? AND message_id = ? AND data = ? AND updated_at = ?
				 )))
				 ON CONFLICT(session_path, message_id) DO UPDATE SET
					data = excluded.data,
					updated_at = excluded.updated_at
				 WHERE ? = 1
				 AND multi_agent_mailbox_messages.data = ?
				 AND multi_agent_mailbox_messages.updated_at = ?`,
				)
				.run(
					sessionPath,
					id,
					plan.serialized,
					new Date().toISOString(),
					hasParentTarget,
					sessionPath,
					plan.parentTarget?.agentId ?? null,
					plan.parentTarget?.data ?? null,
					hasExisting,
					sessionPath,
					id,
					hasExisting,
					sessionPath,
					id,
					plan.existing?.data ?? null,
					plan.existing?.updated_at ?? null,
					hasExisting,
					plan.existing?.data ?? null,
					plan.existing?.updated_at ?? null,
				).changes === 1
		);
	});
}

export function readMultiAgentMailboxRowSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	id: string,
): MultiAgentMailboxRowSnapshot | undefined {
	return db
		.prepare("SELECT data, updated_at FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
		.get(sessionPath, id) as MultiAgentMailboxRowSnapshot | undefined;
}

export function mergeCanonicalMailboxUpdate(
	previous: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const routing = {
		createdAt: previous.createdAt,
		recipientAgentId: previous.recipientAgentId,
		recipientSessionId: previous.recipientSessionId,
		senderAgentId: previous.senderAgentId,
		senderSessionId: previous.senderSessionId,
	};
	if (next.status === "pending" && previous.status === "claimed") {
		return {
			...next,
			...routing,
			claimedAt: previous.claimedAt,
			claimantProcessIdentity: previous.claimantProcessIdentity,
			status: "claimed",
		};
	}
	return { ...next, ...routing };
}

export function getMultiAgentMailboxMessageStatus(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?
				AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`)
			.get(sessionPath, messageId, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as { data: string } | undefined;
		if (!row) {
			return undefined;
		}

		const parsed = parseJsonObject(row.data);
		return typeof parsed?.status === "string" ? parsed.status : undefined;
	});
}

/** IDs of unexpired mailbox rows still persisted for a session, read in one query. */

export function listLiveMultiAgentMailboxMessageIds(controlDbPath: string, sessionPath: string): Set<string> {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(`SELECT message_id FROM multi_agent_mailbox_messages WHERE session_path = ?
				AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`)
			.all(sessionPath, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as Array<{ message_id: string }>;
		return new Set(rows.map((row) => row.message_id));
	});
}

export function markMultiAgentMailboxMessageDelivered(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
): boolean {
	return consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { sessionPath, messageId }) === 1;
}

export function markMultiAgentMailboxMessageFailed(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
	error: string,
): boolean {
	return updateMultiAgentMailboxMessageStatus(controlDbPath, sessionPath, messageId, "failed", error);
}

export function updateMultiAgentMailboxMessageStatus(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
	status: "failed",
	error?: string,
): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowByStoreRef(db, { sessionPath, messageId });
		if (!row) return false;
		const parsed = parseJsonObject(row.data);
		if (!parsed || parsed.status !== "pending") return false;
		const now = new Date().toISOString();
		const updated = { ...parsed, status, updatedAt: now, ...(error === undefined ? {} : { error }) };
		const serialized = JSON.stringify(updated);
		return withImmediateTransaction(db, () =>
			compareAndWriteSerializedCanonicalMailboxPayload(db, row, serialized, now),
		);
	});
}

export function readParentRequestTargetSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	data: unknown,
): ParentRequestTargetSnapshot | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const payload = data as Record<string, unknown>;
	if (payload.kind !== "parent_request") return undefined;
	const fromAgentId = requireStringField(payload, "fromAgentId", "parent_request");
	const toAgentId = requireStringField(payload, "toAgentId", "parent_request");
	const row = readParentRequestTargetRow(db, sessionPath, fromAgentId);
	const sender = row ? parseJsonObject(row.data) : undefined;
	if (!sender || sender.parentId !== toAgentId) {
		throw new Error(`Invalid parent request target at ${sessionPath}#${fromAgentId}`);
	}
	return row;
}

export function readParentRequestTargetRow(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
): ParentRequestTargetSnapshot | undefined {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	return row ? { agentId, data: row.data } : undefined;
}
