import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import { readRuntimeMailboxListenerRow } from "./runtime-mailbox-enqueue.ts";
import { retireSessionHealthForListener, trustedRuntimeMailboxSessionPath } from "./runtime-mailbox-registration.ts";
import { runtimeMailboxAgentIdKey } from "./shared-channel.ts";
import type { RuntimeMailboxAddress, RuntimeMailboxListedRow, RuntimeMailboxListener } from "./types.ts";

export function retireRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	pid: number,
): boolean {
	const nowIso = new Date().toISOString();
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => retireRuntimeMailboxListenerRow(db, recipient, pid, nowIso)),
	);
}

export function retireRuntimeMailboxListenerRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	pid: number,
	nowIso: string,
): boolean {
	const result = db
		.prepare(
			`
			DELETE FROM runtime_mailbox_listeners
			WHERE recipient_session_id = ?
				AND recipient_agent_id_key = ?
				AND pid = ?
			`,
		)
		.run(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId), pid);
	const retired = Number(result.changes) > 0;
	if (retired && recipient.agentId === null) {
		retireSessionHealthForListener(db, recipient.sessionId, pid, nowIso);
	}
	return retired;
}

export function readRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
): { pid: number; sessionPath: string | undefined; updatedAt: string } | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readRuntimeMailboxListenerRow(db, recipient);
		if (!row) return undefined;
		return { pid: row.pid, sessionPath: trustedRuntimeMailboxSessionPath(row), updatedAt: row.updated_at };
	});
}

export function listRuntimeMailboxListeners(controlDbPath: string): RuntimeMailboxListener[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT
					recipient_session_id,
					recipient_agent_id_key,
					pid,
					runtime_instance_id,
					session_path,
					session_path_asserted_at,
					updated_at
				FROM runtime_mailbox_listeners
				`,
			)
			.all() as RuntimeMailboxListedRow[];
		return rows.map(runtimeMailboxListenerFromRow);
	});
}

export function runtimeMailboxListenerFromRow(row: RuntimeMailboxListedRow): RuntimeMailboxListener {
	return {
		sessionId: row.recipient_session_id,
		agentId: row.recipient_agent_id_key === "" ? null : row.recipient_agent_id_key,
		pid: row.pid,
		sessionPath: trustedRuntimeMailboxSessionPath(row),
		updatedAt: row.updated_at,
	};
}
