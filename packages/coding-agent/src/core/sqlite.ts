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

type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase;

interface BunSqliteModule {
	Database: SqliteDatabaseConstructor;
}

interface NodeSqliteModule {
	DatabaseSync: SqliteDatabaseConstructor;
}

const require = createRequire(import.meta.url);

function isBunRuntime(): boolean {
	const runtime = globalThis as typeof globalThis & { Bun?: unknown };
	return runtime.Bun !== undefined;
}

function loadDatabaseConstructor(): SqliteDatabaseConstructor {
	if (isBunRuntime()) {
		return (require("bun:sqlite") as BunSqliteModule).Database;
	}
	return (require("node:sqlite") as NodeSqliteModule).DatabaseSync;
}

export function createSqliteDatabase(path: string): SqliteDatabase {
	const Database = loadDatabaseConstructor();
	return new Database(path);
}
