import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { withControlDb } from "../src/core/session-control-db.ts";

function runOpener(scriptPath: string, directory: string, startAt: string): Promise<string[]> {
	return new Promise((resolveErrors, reject) => {
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
			code === 0 ? resolveErrors(JSON.parse(stdout) as string[]) : reject(new Error(`exit ${code}: ${stderr}`)),
		);
	});
}

test("processes that open the same new control database at the same time all initialize it", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-control-db-concurrent-open-"));
	const scriptPath = join(directory, "open.ts");
	const moduleUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/session-control-db.ts")).href;
	writeFileSync(
		scriptPath,
		`import { withControlDb } from ${JSON.stringify(moduleUrl)};
const [directory, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const errors = [];
for (let index = 0; index < 20; index++) {
	try {
		withControlDb(directory + "/control-" + index + ".sqlite", () => undefined);
	} catch (error) {
		errors.push(String(error));
	}
}
console.log(JSON.stringify(errors));
`,
	);
	try {
		const startAt = String(Date.now() + 2000);
		const errors = await Promise.all(Array.from({ length: 6 }, () => runOpener(scriptPath, directory, startAt)));

		expect(errors.flat()).toEqual([]);
		const columns = withControlDb(join(directory, "control-0.sqlite"), (db) =>
			(db.prepare("PRAGMA table_info(shared_channel_messages)").all() as Array<{ name: string }>).map(
				(column) => column.name,
			),
		);
		expect(columns).toEqual(expect.arrayContaining(["origin_host", "origin_id"]));
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}, 60000);
