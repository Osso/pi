import type { ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject } from "./codecs.ts";

export type TableInfoRow = {
	name: string;
};

export function writeCanonicalMailboxPayload(
	db: SqliteDatabase,
	id: number,
	message: Record<string, unknown>,
	updatedAt: string,
): void {
	const updated = db
		.prepare("UPDATE multi_agent_mailbox_messages SET data = ?, updated_at = ? WHERE rowid = ?")
		.run(JSON.stringify(message), updatedAt, id);
	if (updated.changes !== 1) throw new Error(`Canonical mailbox mutation lost row ${id}`);
}

export function withImmediateTransaction<T>(db: SqliteDatabase, operation: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function normalizeSessionName(name: string | undefined): string | undefined {
	return name?.replace(/[\r\n]+/g, " ").trim() || undefined;
}

export function parseProcessIdentity(value: string, context = "process_identity"): ProcessIdentity {
	const parsed = parseStoredJsonObject(value, context) as Partial<ProcessIdentity>;
	if (!Number.isSafeInteger(parsed.pid) || !Number.isSafeInteger(parsed.startTimeTicks)) {
		throw new Error(`Invalid persisted process identity at ${context}`);
	}
	if (parsed.incarnation !== undefined && typeof parsed.incarnation !== "string") {
		throw new Error(`Invalid persisted process incarnation at ${context}`);
	}
	return {
		pid: parsed.pid,
		startTimeTicks: parsed.startTimeTicks,
		...(parsed.incarnation === undefined ? {} : { incarnation: parsed.incarnation }),
	} as ProcessIdentity;
}

export interface PersistedAgentRow {
	session_path: string;
	agent_id: string;
	data: string;
}

export const TERMINAL_AGENT_ROW_TABLES = [
	"multi_agent_terminal_outbox",
	"multi_agent_runtime_owners",
	"multi_agent_agents",
];
