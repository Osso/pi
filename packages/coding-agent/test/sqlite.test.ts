import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
	configureReadOnlySqliteDatabase,
	configureSharedSqliteDatabase,
	createReadOnlySqliteDatabase,
	createSqliteDatabase,
	type SqliteDatabase,
} from "../src/core/sqlite.ts";

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const contentionFixture = resolve(import.meta.dirname, "fixtures/sqlite-contention.ts");

interface FixtureMessage {
	event: string;
	busyTimeoutMs?: number;
	elapsedMs?: number;
	heldMs?: number;
	contention?: boolean;
	success?: boolean;
}

function startContentionFixture(mode: string, databasePath: string, busyTimeoutMs?: number) {
	const args = [contentionFixture, mode, databasePath];
	if (busyTimeoutMs !== undefined) args.push(String(busyTimeoutMs));
	const child = spawn("bun", args, { stdio: "pipe", timeout: 20000, killSignal: "SIGKILL" });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("error", (error) => {
		stderr += error.message;
	});
	const finished = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
	const lines = createInterface({ input: child.stdout });
	const messages = lines[Symbol.asyncIterator]();

	return {
		child,
		send(command: string) {
			child.stdin.write(`${command}\n`);
		},
		async next(event: string): Promise<FixtureMessage> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const line = await Promise.race([
					messages.next(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`Timed out waiting for ${mode}:${event}: ${stderr}`)),
							12000,
						);
					}),
				]);
				if (line.done) throw new Error(`${mode} exited before ${event}: ${stderr}`);
				const message = JSON.parse(line.value) as FixtureMessage;
				expect(message.event).toBe(event);
				return message;
			} finally {
				clearTimeout(timer);
			}
		},
		async finish() {
			child.stdin.end();
			expect(await finished, stderr).toBe(0);
		},
		async stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await finished;
			lines.close();
		},
	};
}

async function contendWithWriter(busyTimeoutMs?: number) {
	const directory = mkdtempSync(join(tmpdir(), "pi-bun-sqlite-contention-"));
	const databasePath = join(directory, "test.sqlite");
	const children: ReturnType<typeof startContentionFixture>[] = [];
	try {
		const writer = startContentionFixture("writer", databasePath);
		children.push(writer);
		await writer.next("locked");
		const contender = startContentionFixture("contender", databasePath, busyTimeoutMs);
		children.push(contender);
		await contender.next("ready");
		contender.send("write");
		await contender.next("attempting");
		if (busyTimeoutMs === undefined) writer.send("release-after-wait");
		const result = await contender.next("result");
		const writerAliveOnResult = writer.child.exitCode === null && writer.child.signalCode === null;
		if (busyTimeoutMs !== undefined) writer.send("release");
		const release = await writer.next("released");
		await Promise.all([contender.finish(), writer.finish()]);
		const persisted = spawnSync("bun", [contentionFixture, "read", databasePath], {
			encoding: "utf8",
			timeout: 5000,
			killSignal: "SIGKILL",
		});
		expect(persisted.status, persisted.stderr).toBe(0);
		const rows = JSON.parse(persisted.stdout) as { value: string }[];
		return { result, release, rows, writerAliveOnResult };
	} finally {
		await Promise.all(children.map((child) => child.stop()));
		rmSync(directory, { force: true, recursive: true });
	}
}

describe("SQLite adapter", () => {
	test("read-only connections use the shared default and honor an explicit timeout", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-readonly-timeout-"));
		const databasePath = join(directory, "control.sqlite");
		try {
			const writable = createSqliteDatabase(databasePath);
			try {
				writable.exec("CREATE TABLE values_table (value INTEGER)");
			} finally {
				writable.close();
			}
			const readonly = createReadOnlySqliteDatabase(databasePath);
			try {
				configureReadOnlySqliteDatabase(readonly);
				expect(readonly.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 10000 });
				configureReadOnlySqliteDatabase(readonly, 150);
				expect(readonly.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 150 });
			} finally {
				readonly.close();
			}
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test("gives up enabling WAL when the database stays busy for the whole busy timeout", () => {
		const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		let walAttempts = 0;
		const database: SqliteDatabase = {
			close: () => {},
			exec: (sql) => {
				if (sql !== "PRAGMA journal_mode = WAL") return;
				walAttempts += 1;
				throw busy;
			},
			prepare: () => ({
				all: () => [],
				get: () => ({ journal_mode: "delete" }),
				run: () => ({ changes: 0, lastInsertRowid: 0 }),
			}),
		};
		// Full backoff without jitter: retries at about 5, 15, 35 and 75 ms. The next 80 ms sleep must stop at 100 ms.
		const random = vi.spyOn(Math, "random").mockReturnValue(0.999999);
		const startedAt = performance.now();
		try {
			expect(() => configureSharedSqliteDatabase(database, { busyTimeoutMs: 100 })).toThrow(busy);
		} finally {
			random.mockRestore();
		}
		const elapsedMs = performance.now() - startedAt;
		expect(walAttempts).toBeGreaterThan(1);
		expect(elapsedMs).toBeGreaterThanOrEqual(95);
		expect(elapsedMs).toBeLessThan(135);
	});

	test("processes that open the same new database at the same time all enable WAL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-sqlite-concurrent-create-"));
		const scriptPath = join(directory, "open.ts");
		const sqliteModuleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/sqlite.ts")).href;
		writeFileSync(
			scriptPath,
			`import { configureSharedSqliteDatabase, createSqliteDatabase } from ${JSON.stringify(sqliteModuleUrl)};
const [directory, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const errors = [];
for (let index = 0; index < 40; index++) {
	const database = createSqliteDatabase(directory + "/db-" + index + ".sqlite");
	try {
		configureSharedSqliteDatabase(database);
		database.exec("CREATE TABLE IF NOT EXISTS values_table (value INTEGER)");
	} catch (error) {
		errors.push(String(error));
	} finally {
		database.close();
	}
}
console.log(JSON.stringify(errors));
`,
		);
		try {
			const startAt = String(Date.now() + 1500);
			const outputs = await Promise.all(
				Array.from(
					{ length: 8 },
					() =>
						new Promise<string>((resolveOutput, reject) => {
							const child = spawn(process.execPath, [scriptPath, directory, startAt], { stdio: "pipe" });
							let stdout = "";
							let stderr = "";
							child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
								stdout += chunk;
							});
							child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
								stderr += chunk;
							});
							child.once("error", reject);
							child.once("close", (code) =>
								code === 0 ? resolveOutput(stdout) : reject(new Error(`exit ${code}: ${stderr}`)),
							);
						}),
				),
			);
			const errors = outputs.flatMap((output) => JSON.parse(output) as string[]);
			expect(errors).toEqual([]);
			const database = createReadOnlySqliteDatabase(join(directory, "db-0.sqlite"));
			try {
				expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
			} finally {
				database.close();
			}
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	}, 30000);

	test.runIf(hasBun)(
		"Bun default shared timeout persists a write after another process holds the lock beyond five seconds",
		async () => {
			const { result, release, rows } = await contendWithWriter();
			expect.soft(result).toMatchObject({ busyTimeoutMs: 10000, contention: false, success: true });
			expect.soft(result.elapsedMs).toBeGreaterThanOrEqual(6000);
			expect.soft(release.heldMs).toBeGreaterThanOrEqual(6500);
			expect(rows).toEqual([{ value: "contender" }, { value: "writer" }]);
		},
		30000,
	);

	test.runIf(hasBun)(
		"Bun respects an explicit short shared timeout while another process still owns the write lock",
		async () => {
			const { result, rows, writerAliveOnResult } = await contendWithWriter(150);
			expect(result).toMatchObject({ busyTimeoutMs: 150, contention: true, success: false });
			expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
			expect(result.elapsedMs).toBeLessThan(3000);
			expect(writerAliveOnResult).toBe(true);
			expect(rows).toEqual([{ value: "writer" }]);
		},
		30000,
	);

	test.runIf(hasBun)("Bun reports a session root as indexed only after it was marked", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bun-sqlite-indexed-root-"));
		const scriptPath = join(directory, "check.ts");
		const metadataModuleUrl = pathToFileURL(
			resolve(import.meta.dirname, "../src/core/session-control-db/session-metadata.ts"),
		).href;
		writeFileSync(
			scriptPath,
			`import { isSessionRootIndexed, markSessionRootIndexed } from ${JSON.stringify(metadataModuleUrl)};
const controlDbPath = ${JSON.stringify(join(directory, "control.sqlite"))};
const root = "/home/user/.config/pi/agent/sessions";
const before = isSessionRootIndexed(controlDbPath, root);
markSessionRootIndexed(controlDbPath, root);
console.log(JSON.stringify({ before, after: isSessionRootIndexed(controlDbPath, root) }));
`,
		);

		try {
			const result = spawnSync("bun", [scriptPath], { encoding: "utf8" });
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ before: false, after: true });
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	test.runIf(process.platform === "linux" && hasBun)(
		"Bun closes prepared statements before closing each database connection",
		() => {
			const directory = mkdtempSync(join(tmpdir(), "pi-bun-sqlite-fd-"));
			const scriptPath = join(directory, "check.ts");
			const databasePath = join(directory, "control.sqlite");
			const sqliteModuleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/sqlite.ts")).href;
			writeFileSync(
				scriptPath,
				`import { readdirSync } from "node:fs";
import { createSqliteDatabase } from ${JSON.stringify(sqliteModuleUrl)};
const before = readdirSync("/proc/self/fd").length;
for (let index = 0; index < 100; index++) {
	const database = createSqliteDatabase(${JSON.stringify(databasePath)});
	database.exec("CREATE TABLE IF NOT EXISTS values_table (value INTEGER)");
	database.prepare("SELECT count(*) FROM values_table").get();
	database.close();
}
const after = readdirSync("/proc/self/fd").length;
console.log(JSON.stringify({ before, after }));
`,
			);

			try {
				const result = spawnSync("bun", [scriptPath], { encoding: "utf8" });
				expect(result.status, result.stderr).toBe(0);
				const counts = JSON.parse(result.stdout) as { after: number; before: number };
				expect(counts.after - counts.before).toBeLessThanOrEqual(2);
			} finally {
				rmSync(directory, { force: true, recursive: true });
			}
		},
	);
});
