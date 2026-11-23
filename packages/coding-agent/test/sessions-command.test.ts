import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSessionsCommand } from "../src/cli/sessions-command.ts";
import {
	archiveSession,
	getControlDbPath,
	readSessionMetadata,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";

describe("sessions command", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		process.exitCode = undefined;
		vi.unstubAllEnvs();
		for (const directory of tempDirs.splice(0)) rmSync(directory, { force: true, recursive: true });
	});

	it("archives sessions using a five-day default cutoff", async () => {
		let cutoff: Date | undefined;
		const output: string[] = [];
		const handled = await handleSessionsCommand(["sessions", "archive"], {
			stdout: (text) => output.push(text),
			now: () => new Date("2026-07-10T00:00:00.000Z"),
			refreshMetadata: async () => {},
			archiveOlderThan: (_path, value) => {
				cutoff = value;
				return ["/tmp/old.jsonl", "/tmp/older.jsonl"];
			},
		});

		expect(handled).toBe(true);
		expect(cutoff?.toISOString()).toBe("2026-07-05T00:00:00.000Z");
		expect(output).toEqual(["Archived 2 sessions older than 5 days.\n"]);
	});

	it("keeps a relocated session's indexed cwd when it refreshes metadata before archiving", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-sessions-archive-cwd-"));
		tempDirs.push(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const projectA = join(agentDir, "project-a");
		const projectB = join(agentDir, "project-b");
		const sessionDir = join(agentDir, "sessions", "--project-a--");
		mkdirSync(sessionDir, { recursive: true });
		const sessionPath = join(sessionDir, "relocated.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "session", version: 3, id: "relocated", timestamp: "2026-07-01T00:00:00.000Z", cwd: projectA })}\n` +
				`${JSON.stringify({ type: "message", id: "1", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } })}\n`,
		);
		const controlDbPath = getControlDbPath(agentDir);
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: "relocated",
			cwd: projectB,
			createdAt: "2026-07-01T00:00:00.000Z",
			modifiedAt: "2026-07-01T00:00:01.000Z",
			messageCount: 1,
			firstMessage: "hi",
		});

		await handleSessionsCommand(["sessions", "archive"], {
			controlDbPath,
			stdout: () => {},
			now: () => new Date("2026-07-10T00:00:00.000Z"),
			archiveOlderThan: () => [],
		});

		expect(readSessionMetadata(controlDbPath, sessionPath)?.cwd).toBe(projectB);
	});

	it("accepts an explicit day cutoff", async () => {
		let cutoff: Date | undefined;
		await handleSessionsCommand(["sessions", "archive", "--older-than", "2"], {
			stdout: () => {},
			now: () => new Date("2026-07-10T00:00:00.000Z"),
			refreshMetadata: async () => {},
			archiveOlderThan: (_path, value) => {
				cutoff = value;
				return [];
			},
		});

		expect(cutoff?.toISOString()).toBe("2026-07-08T00:00:00.000Z");
	});

	it("migrates archived plain transcripts while preserving resident and compressed sessions", async () => {
		const output: string[] = [];
		const failures: string[] = [];
		const migrated: string[] = [];
		const archivedSessions = [
			{ id: "old", sessionPath: "/tmp/old.jsonl" },
			{ id: "supervisor", sessionPath: "/tmp/supervisor-sessions/supervisor.jsonl" },
			{ id: "architect", sessionPath: "/tmp/architect-sessions/architect.jsonl" },
			{ id: "compressed", sessionPath: "/tmp/compressed.jsonl.zst" },
			{ id: "broken", sessionPath: "/tmp/broken.jsonl" },
		];
		const dependencies = {
			stdout: (text: string) => output.push(text),
			stderr: (text: string) => failures.push(text),
			listArchivedSessions: () => archivedSessions,
			compressArchivedSession: (_controlDbPath: string, sessionPath: string) => {
				if (sessionPath === "/tmp/broken.jsonl") throw new Error("permission denied");
				migrated.push(sessionPath);
				return `${sessionPath}.zst`;
			},
		};

		await handleSessionsCommand(["sessions", "compress-archived", "--dry-run"], dependencies);
		expect(migrated).toEqual([]);
		expect(output).toEqual([
			"Would migrate 2 archived sessions. Skipped 3. Failed 0.\n",
			"Would migrate:\n/tmp/old.jsonl\n/tmp/broken.jsonl\n",
			"Skipped:\n/tmp/supervisor-sessions/supervisor.jsonl\n/tmp/architect-sessions/architect.jsonl\n/tmp/compressed.jsonl.zst\n",
		]);

		output.length = 0;
		await handleSessionsCommand(["sessions", "compress-archived"], dependencies);
		expect(migrated).toEqual(["/tmp/old.jsonl"]);
		expect(output).toEqual([
			"Migrated 1 archived session. Skipped 3. Failed 1.\n",
			"Migrated:\n/tmp/old.jsonl.zst\n",
			"Skipped:\n/tmp/supervisor-sessions/supervisor.jsonl\n/tmp/architect-sessions/architect.jsonl\n/tmp/compressed.jsonl.zst\n",
			"Failed:\n/tmp/broken.jsonl: permission denied\n",
		]);
		expect(failures).toEqual(["Archived-session migration failures:\n/tmp/broken.jsonl: permission denied\n"]);
	});

	it("migrates stored archived transcripts and makes reruns no-ops", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-compress-archived-"));
		tempDirs.push(agentDir);
		const controlDbPath = getControlDbPath(agentDir);
		const archivedPath = join(agentDir, "old.jsonl");
		const supervisorPath = join(agentDir, "supervisor-sessions", "supervisor.jsonl");
		writeFileSync(archivedPath, '{"type":"session","id":"old"}\n');
		mkdirSync(join(agentDir, "supervisor-sessions"));
		writeFileSync(supervisorPath, '{"type":"session","id":"supervisor"}\n');
		for (const [id, sessionPath] of [
			["old", archivedPath],
			["supervisor", supervisorPath],
		] as const) {
			writeSessionMetadata(controlDbPath, {
				sessionPath,
				id,
				cwd: agentDir,
				createdAt: "2026-09-02T00:00:00.000Z",
				modifiedAt: "2026-09-02T00:00:00.000Z",
				messageCount: 0,
				firstMessage: "",
			});
		}
		archiveSession(controlDbPath, archivedPath);
		archiveSession(controlDbPath, supervisorPath);
		const output: string[] = [];
		const dependencies = { controlDbPath, stdout: (text: string) => output.push(text) };

		await handleSessionsCommand(["sessions", "compress-archived", "--dry-run"], dependencies);
		expect(existsSync(archivedPath)).toBe(true);
		expect(existsSync(`${archivedPath}.zst`)).toBe(false);
		output.length = 0;
		await handleSessionsCommand(["sessions", "compress-archived"], dependencies);
		expect(existsSync(archivedPath)).toBe(false);
		expect(existsSync(`${archivedPath}.zst`)).toBe(true);
		expect(readSessionMetadata(controlDbPath, `${archivedPath}.zst`)?.isArchived).toBe(true);
		expect(readSessionMetadata(controlDbPath, archivedPath)).toBeUndefined();
		expect(existsSync(supervisorPath)).toBe(true);

		output.length = 0;
		await handleSessionsCommand(["sessions", "compress-archived"], dependencies);
		expect(output[0]).toBe("Migrated 0 archived sessions. Skipped 2. Failed 0.\n");
	});

	it("reports tool-result truncation through the migration command", async () => {
		const output: string[] = [];
		const handled = await handleSessionsCommand(["sessions", "truncate-tool-output"], {
			stdout: (text) => output.push(text),
			agentDir: "/tmp/pi-agent",
			truncateToolOutput: (agentDir) => {
				expect(agentDir).toBe("/tmp/pi-agent");
				return {
					scannedFiles: 3,
					changedFiles: 2,
					truncatedMessages: 4,
					skippedMalformedFiles: 1,
					skippedNonSessionFiles: 0,
					skippedErrorFiles: 0,
					backupPaths: [],
					errors: [],
				};
			},
		});

		expect(handled).toBe(true);
		expect(output).toEqual(["Truncated 4 tool results in 2 sessions. Skipped 1 file.\n"]);
	});

	it("reports migration errors and sets a failing exit code", async () => {
		const output: string[] = [];
		const errors: string[] = [];
		process.exitCode = undefined;
		await handleSessionsCommand(["sessions", "truncate-tool-output"], {
			stdout: (text) => output.push(text),
			stderr: (text) => errors.push(text),
			truncateToolOutput: () => ({
				scannedFiles: 1,
				changedFiles: 0,
				truncatedMessages: 0,
				skippedMalformedFiles: 1,
				skippedNonSessionFiles: 0,
				skippedErrorFiles: 0,
				backupPaths: [],
				errors: ["/tmp/broken.jsonl: malformed JSONL"],
			}),
		});

		expect(process.exitCode).toBe(1);
		expect(output).toEqual(["Truncated 0 tool results in 0 sessions. Skipped 1 file.\n"]);
		expect(errors).toEqual(["Migration errors:\n/tmp/broken.jsonl: malformed JSONL\n"]);
		process.exitCode = undefined;
	});
});
