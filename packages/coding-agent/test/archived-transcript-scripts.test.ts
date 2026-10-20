import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

it.each(["cost.ts", "stats.ts", "tool-stats.ts", "session-transcripts.ts"])(
	"%s includes archived messages",
	(script) => {
		const root = mkdtempSync(join(tmpdir(), "pi-archive-script-ts-"));
		roots.push(root);
		const cwd = join(root, "project");
		const encoded = `--${cwd.slice(1).replaceAll("/", "-")}--`;
		const sessionDir = join(root, ".pi", "agent", "sessions", encoded);
		mkdirSync(sessionDir, { recursive: true });
		const timestamp = new Date();
		const file = join(
			sessionDir,
			`${timestamp.toISOString().replaceAll(":", "-").replaceAll(".", "-")}_test.jsonl.zst`,
		);
		const entries = [
			{ type: "session", version: 3, id: "test", cwd, timestamp: timestamp.toISOString() },
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp: timestamp.toISOString(),
				message: { role: "user", content: "archived script needle", timestamp: timestamp.getTime() },
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp: timestamp.toISOString(),
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-5.5",
					timestamp: timestamp.getTime(),
					content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "example.ts" } }],
					usage: { input: 17, output: 3, totalTokens: 20, cost: { input: 0.1, output: 0.2, total: 0.3 } },
				},
			},
		];
		writeFileSync(
			file,
			zstdCompressSync(Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)),
		);
		const output = join(root, "output.html");
		const scriptArgs =
			script === "cost.ts"
				? ["--dir", cwd, "--days", "365"]
				: script === "stats.ts"
					? ["--dir", cwd, "--days", "365"]
					: script === "tool-stats.ts"
						? ["--sessions-dir", sessionDir, "--output", output]
						: [cwd, "--output", join(root, "transcripts")];
		const text = execFileSync(
			process.execPath,
			[resolve(import.meta.dirname, "../../../scripts", script), ...scriptArgs],
			{ encoding: "utf8", env: { ...process.env, HOME: root, BROWSER: "true" } },
		);
		if (script === "session-transcripts.ts")
			expect(readFileSync(join(root, "transcripts", "session-transcripts-000.txt"), "utf8")).toContain(
				"archived script needle",
			);
		else if (script === "tool-stats.ts") expect(readFileSync(output, "utf8")).toContain("1 session files");
		else expect(text).toContain("0.3000");
	},
);
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["session-context-stats.mjs", "read-tool-stats.mjs", "edit-tool-stats.mjs"])(
	"%s scans compressed transcripts just like plain ones",
	(script) => {
		const root = mkdtempSync(join(tmpdir(), "pi-archive-script-"));
		roots.push(root);
		const session = join(root, "2026-10-01T00-00-00-000Z_test.jsonl");
		const lines = [
			{ type: "session", id: "test", cwd: root, timestamp: "2026-10-01T00:00:00Z" },
			{ type: "message", id: "user", message: { role: "user", content: "a searchable archived message" } },
			{
				type: "message",
				id: "assistant",
				message: {
					role: "assistant",
					model: "gpt-5.5",
					provider: "openai",
					content: [{ type: "toolCall", id: "read-one", name: "read", arguments: { path: "src/example.ts" } }],
					usage: { input: 100, output: 10, totalTokens: 110 },
				},
			},
		];
		writeFileSync(session, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const args = [
			resolve(import.meta.dirname, "../../../scripts", script),
			"--sessions-dir",
			root,
			"--json",
			"--all-sessions",
		];
		const run = () => {
			const output = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
			return output.summary ?? output;
		};
		const plain = run();
		writeFileSync(`${session}.zst`, zstdCompressSync(readFileSync(session)));
		unlinkSync(session);
		const archived = run();
		expect(archived.scan.sessionFilesIncluded).toBe(1);
		expect(archived.scan.malformedLines).toBe(0);
		expect(archived.scan).toEqual(plain.scan);
	},
);
