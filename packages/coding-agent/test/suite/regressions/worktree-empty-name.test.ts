import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("--worktree with an empty name", () => {
	it("fails startup instead of silently running in the original checkout", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worktree-empty-"));
		try {
			const result = spawnSync(
				process.execPath,
				[
					join(import.meta.dirname, "../../../src/cli.ts"),
					"--offline",
					"--no-supervisor",
					"--no-session",
					"--worktree",
					"",
					"-p",
					"question",
				],
				{
					cwd: root,
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_STATE_DIR: root },
					timeout: 20000,
				},
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('Invalid worktree name ""');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
