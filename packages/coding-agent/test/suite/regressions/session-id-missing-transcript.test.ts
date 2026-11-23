import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runPi(cwd: string, agentDir: string, sessionDir: string) {
	return spawnSync(
		process.execPath,
		[
			join(import.meta.dirname, "../../../src/cli.ts"),
			"--offline",
			"--session-dir",
			sessionDir,
			"--session",
			"stale-id",
			"--model",
			"missing-model",
			"-p",
			"hi",
		],
		{
			cwd,
			encoding: "utf8",
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_STATE_DIR: agentDir },
			timeout: 30000,
		},
	);
}

describe("--session <id> whose indexed transcript was removed", () => {
	it("fails the lookup instead of starting a replacement session at the old path", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-missing-transcript-"));
		const workspace = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		for (const dir of [workspace, sessionDir, agentDir]) mkdirSync(dir);
		try {
			const timestamp = new Date().toISOString();
			const transcript = join(sessionDir, "stale-id.jsonl");
			const entries = [
				{ type: "session", version: 3, id: "stale-id", timestamp, cwd: workspace },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp,
					message: { role: "user", content: "hello", timestamp: Date.now() },
				},
			];
			writeFileSync(transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			// The first run indexes the session and reaches model selection.
			expect(runPi(workspace, agentDir, sessionDir).stderr).toContain('Model "missing-model" not found');
			rmSync(transcript);

			const result = runPi(workspace, agentDir, sessionDir);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`Error: Session transcript is missing: ${transcript}`);
			expect(readdirSync(sessionDir)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
