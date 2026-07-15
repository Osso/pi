import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

describe("SQLite adapter", () => {
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
