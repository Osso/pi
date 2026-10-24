import { createInterface, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
	configureSharedSqliteDatabase,
	createSqliteDatabase,
	isSqliteContentionError,
	type SqliteDatabase,
} from "../../src/core/sqlite.ts";

async function runWriter(database: SqliteDatabase, commands: Interface): Promise<void> {
	database.exec("CREATE TABLE contention_values (value TEXT PRIMARY KEY)");
	database.exec("BEGIN IMMEDIATE");
	database.prepare("INSERT INTO contention_values VALUES (?)").run("writer");
	const lockedAt = performance.now();
	console.log(JSON.stringify({ event: "locked" }));
	for await (const command of commands) {
		if (command === "release-after-wait") await delay(6500);
		else if (command !== "release") throw new Error(`Unexpected writer command: ${command}`);
		database.exec("COMMIT");
		console.log(JSON.stringify({ event: "released", heldMs: performance.now() - lockedAt }));
		break;
	}
}

async function runContender(database: SqliteDatabase, commands: Interface): Promise<void> {
	const row = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
	console.log(JSON.stringify({ event: "ready" }));
	for await (const command of commands) {
		if (command !== "write") throw new Error(`Unexpected contender command: ${command}`);
		const startedAt = performance.now();
		console.log(JSON.stringify({ event: "attempting" }));
		let contention = false;
		let success = false;
		try {
			database.prepare("INSERT INTO contention_values VALUES (?)").run("contender");
			success = true;
		} catch (error) {
			if (!isSqliteContentionError(error)) throw error;
			contention = true;
		}
		console.log(
			JSON.stringify({
				event: "result",
				busyTimeoutMs: row.timeout,
				elapsedMs: performance.now() - startedAt,
				contention,
				success,
			}),
		);
		break;
	}
}

const [mode, databasePath, timeout] = process.argv.slice(2);
if (!databasePath) throw new Error("A temporary database path is required");
const database = createSqliteDatabase(databasePath);

try {
	if (mode === "read") {
		console.log(JSON.stringify(database.prepare("SELECT value FROM contention_values ORDER BY value").all()));
	} else {
		configureSharedSqliteDatabase(database, timeout === undefined ? undefined : { busyTimeoutMs: Number(timeout) });
		const commands = createInterface({ input: process.stdin });
		try {
			if (mode === "writer") {
				await runWriter(database, commands);
			} else if (mode === "contender") {
				await runContender(database, commands);
			} else {
				throw new Error(`Unexpected fixture mode: ${mode}`);
			}
		} finally {
			commands.close();
		}
	}
} finally {
	database.close();
}
