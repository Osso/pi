import { createRequire } from "node:module";

export type SqliteValue = Uint8Array | bigint | boolean | number | string | null;

export interface SqliteRunResult {
	changes: number;
	lastInsertRowid: bigint | number;
}

export interface SqliteStatement {
	all(...values: SqliteValue[]): unknown[];
	get(...values: SqliteValue[]): unknown;
	run(...values: SqliteValue[]): SqliteRunResult;
}

export interface SqliteDatabase {
	close(): void;
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
}

type BunSqliteDatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => SqliteDatabase;
type NodeSqliteDatabaseConstructor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

interface BunSqliteModule {
	Database: BunSqliteDatabaseConstructor;
}

interface NodeSqliteModule {
	DatabaseSync: NodeSqliteDatabaseConstructor;
}

const require = createRequire(import.meta.url);

function isBunRuntime(): boolean {
	const runtime = globalThis as typeof globalThis & { Bun?: unknown };
	return runtime.Bun !== undefined;
}

export function createSqliteDatabase(path: string): SqliteDatabase {
	if (isBunRuntime()) {
		const { Database } = require("bun:sqlite") as BunSqliteModule;
		return new Database(path);
	}
	const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
	return new DatabaseSync(path);
}

/** Opens an existing SQLite database without changing its configuration or contents. */
export function createReadOnlySqliteDatabase(path: string): SqliteDatabase {
	if (isBunRuntime()) {
		const { Database } = require("bun:sqlite") as BunSqliteModule;
		return new Database(path, { readonly: true });
	}
	const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
	return new DatabaseSync(path, { readOnly: true });
}

/** Default multi-consumer open settings for shared process-local SQLite DBs. */
export const DEFAULT_SHARED_SQLITE_BUSY_TIMEOUT_MS = 5000;

export interface ConfigureSharedSqliteDatabaseOptions {
	busyTimeoutMs?: number;
}

/**
 * Configure a SQLite connection for concurrent multi-process access.
 * Enables WAL so readers do not block writers (and vice versa) and sets a busy timeout.
 */
export function configureSharedSqliteDatabase(
	db: SqliteDatabase,
	options: ConfigureSharedSqliteDatabaseOptions = {},
): void {
	const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SHARED_SQLITE_BUSY_TIMEOUT_MS;
	db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	const journalMode = readPragmaValue(db, "PRAGMA journal_mode");
	if (journalMode !== "wal") {
		db.exec("PRAGMA journal_mode = WAL");
	}
	const synchronous = readPragmaValue(db, "PRAGMA synchronous");
	// 1 == NORMAL. WAL + NORMAL is the standard multi-consumer throughput tradeoff.
	if (synchronous !== "1" && synchronous !== "normal") {
		db.exec("PRAGMA synchronous = NORMAL");
	}
}

function readPragmaValue(db: SqliteDatabase, sql: string): string {
	const row = db.prepare(sql).get() as Record<string, unknown> | string | number | null | undefined;
	if (row === null || row === undefined) {
		return "";
	}
	if (typeof row === "string" || typeof row === "number") {
		return String(row).toLowerCase();
	}
	const value = Object.values(row)[0];
	if (typeof value === "string" || typeof value === "number") {
		return String(value).toLowerCase();
	}
	return "";
}
