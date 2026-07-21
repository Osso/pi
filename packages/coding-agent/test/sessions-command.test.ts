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
});
