import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareResidentSessionFile } from "../src/core/resident-session.ts";
import { listSessionMetadata, writeSessionMetadata } from "../src/core/session-control-db.ts";

for (const role of ["architect", "supervisor"] as const) {
	describe(`${role} resident metadata cleanup`, () => {
		for (const separator of ["/", "\\"]) {
			it(`removes only missing resident paths with ${JSON.stringify(separator)} separators`, () => {
				const root = mkdtempSync(join(tmpdir(), "pi-resident-metadata-"));
				try {
					const controlDbPath = join(root, "control.sqlite");
					const agentDir = join(root, "agent");
					const otherRole = role === "architect" ? "supervisor" : "architect";
					const residentPath = (segment: string, file: string) =>
						`${root}${separator}${segment}${separator}${file}`;
					const existingPath = residentPath(`${role}-sessions`, "existing.jsonl");
					mkdirSync(dirname(existingPath), { recursive: true });
					writeFileSync(existingPath, "existing resident\n");
					const rows = [
						{ id: "missing-path", sessionPath: residentPath(`${role}-sessions`, "missing.jsonl"), retain: false },
						{ id: "existing-path", sessionPath: existingPath, retain: true },
						{ id: role, sessionPath: join(root, "id-only-missing.jsonl"), retain: false },
						{
							id: "other-role",
							sessionPath: residentPath(`${otherRole}-sessions`, "missing.jsonl"),
							retain: true,
						},
						{ id: "prefix", sessionPath: residentPath(`not-${role}-sessions`, "missing.jsonl"), retain: true },
						{ id: "suffix", sessionPath: residentPath(`${role}-sessions-extra`, "missing.jsonl"), retain: true },
					];
					for (const row of rows) {
						expect(existsSync(row.sessionPath)).toBe(row.sessionPath === existingPath);
						writeSessionMetadata(controlDbPath, {
							id: row.id,
							sessionPath: row.sessionPath,
							cwd: root,
							createdAt: "2026-10-21T00:00:00.000Z",
							modifiedAt: "2026-10-21T00:00:00.000Z",
							messageCount: 0,
							firstMessage: "",
						});
					}
					expect(listSessionMetadata(controlDbPath)).toHaveLength(rows.length);

					expect(prepareResidentSessionFile(agentDir, role, controlDbPath)).toEqual({
						sessionDir: join(agentDir, `${role}-sessions`),
						sessionPath: join(agentDir, `${role}-sessions`, `${role}.jsonl`),
					});
					expect(
						listSessionMetadata(controlDbPath)
							.map((row) => row.id)
							.sort(),
					).toEqual(
						rows
							.filter((row) => row.retain)
							.map((row) => row.id)
							.sort(),
					);
					expect(readFileSync(existingPath, "utf8")).toBe("existing resident\n");
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			});
		}
	});
}
