import { describe, expect, it } from "vitest";
import { handleSessionsCommand } from "../src/cli/sessions-command.ts";

describe("sessions command", () => {
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
