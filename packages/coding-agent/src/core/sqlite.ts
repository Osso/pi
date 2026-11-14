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

interface BunSqliteStatement extends SqliteStatement {
	finalize(): void;
}

export interface SqliteDatabase {
	close(): void;
	exec(sql: string): void;
	finalizeStatements?(): void;
	prepare(sql: string): SqliteStatement;
}

interface BunSqliteDatabase extends Omit<SqliteDatabase, "prepare"> {
	prepare(sql: string): BunSqliteStatement;
}

type BunSqliteDatabaseConstructor = new (path: string, options?: { readonly?: boolean }) => BunSqliteDatabase;
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
	if (isBunRuntime()) return createBunSqliteDatabase(path);
	const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
	return new DatabaseSync(path);
}

/** Opens an existing SQLite database without changing its configuration or contents. */
export function createReadOnlySqliteDatabase(path: string): SqliteDatabase {
	if (isBunRuntime()) return createBunSqliteDatabase(path, { readonly: true });
	const { DatabaseSync } = require("node:sqlite") as NodeSqliteModule;
	return new DatabaseSync(path, { readOnly: true });
}

function createBunSqliteDatabase(path: string, options?: { readonly?: boolean }): SqliteDatabase {
	const { Database } = require("bun:sqlite") as BunSqliteModule;
	const database = new Database(path, options);
	const statements = new Set<BunSqliteStatement>();
	const finalizeStatements = () => {
		for (const statement of statements) statement.finalize();
		statements.clear();
	};
	return {
		close: () => {
			finalizeStatements();
			database.close();
		},
		exec: (sql) => database.exec(sql),
		finalizeStatements,
		prepare: (sql) => {
			const statement = database.prepare(sql);
			statements.add(statement);
			return statement;
		},
	};
}

/** Default multi-consumer open settings for shared process-local SQLite DBs. */
export const DEFAULT_SHARED_SQLITE_BUSY_TIMEOUT_MS = 10000;

/**
 * Configure a read-only SQLite connection for concurrent access.
 * The busy timeout is connection-local and does not change database journal settings.
 */
export function configureReadOnlySqliteDatabase(
	db: SqliteDatabase,
	busyTimeoutMs = DEFAULT_SHARED_SQLITE_BUSY_TIMEOUT_MS,
): void {
	db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
}

export interface ConfigureSharedSqliteDatabaseOptions {
	busyTimeoutMs?: number;
}

export function isSqliteContentionError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return false;
	if (error.code === "SQLITE_BUSY" || error.code.startsWith("SQLITE_BUSY_")) return true;
	if (error.code === "SQLITE_LOCKED" || error.code.startsWith("SQLITE_LOCKED_")) return true;
	if (error.code !== "ERR_SQLITE_ERROR" || !("errcode" in error)) return false;
	return error.errcode === 5 || error.errcode === 6;
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
		enableWalJournalMode(db, busyTimeoutMs);
	}
	const synchronous = readPragmaValue(db, "PRAGMA synchronous");
	// 1 == NORMAL. WAL + NORMAL is the standard multi-consumer throughput tradeoff.
	if (synchronous !== "1" && synchronous !== "normal") {
		db.exec("PRAGMA synchronous = NORMAL");
	}
}

const retrySleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * SQLite takes the exclusive lock for a journal-mode change without calling the busy handler, so processes that
 * open a new database at the same time get SQLITE_BUSY at once. Retry within the busy timeout instead.
 */
function enableWalJournalMode(db: SqliteDatabase, busyTimeoutMs: number): void {
	const deadline = Date.now() + busyTimeoutMs;
	for (let delayMs = 5; ; delayMs = Math.min(delayMs * 2, 200)) {
		try {
			db.exec("PRAGMA journal_mode = WAL");
			return;
		} catch (error) {
			const remainingMs = deadline - Date.now();
			if (!isSqliteContentionError(error) || remainingMs <= 0) throw error;
			Atomics.wait(retrySleepCell, 0, 0, Math.min(remainingMs, delayMs * (0.5 + Math.random() / 2)));
		}
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
