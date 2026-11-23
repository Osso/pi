import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function writeSession(dir: string, cwd: string, id: string): void {
	const timestamp = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id, timestamp, cwd },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "hello", timestamp: Date.now() },
		},
	];
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("relative --session-dir", () => {
	it("finds a session by ID in --session-dir . like the absolute directory", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-dir-relative-"));
		const workspace = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(workspace);
		mkdirSync(agentDir);
		try {
			writeSession(workspace, workspace, "dot-root");
			const result = spawnSync(
				process.execPath,
				[
					join(import.meta.dirname, "../../../src/cli.ts"),
					"--offline",
					"--session-dir",
					".",
					"--session",
					"dot-root",
					"--model",
					"missing-model",
					"-p",
					"hi",
				],
				{
					cwd: workspace,
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_STATE_DIR: agentDir },
					timeout: 30000,
				},
			);

			// The session opens, so startup reaches model selection and fails there instead of at lookup.
			expect(result.stderr).not.toContain("No session found matching 'dot-root'");
			expect(result.stderr).toContain('Model "missing-model" not found');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
