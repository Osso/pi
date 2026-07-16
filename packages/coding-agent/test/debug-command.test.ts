import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleDebugCommand } from "../src/cli/debug-command.ts";
import { getDebugSocketPath } from "../src/core/debug-repl.ts";
import { getControlDbPath, writeSessionHealth } from "../src/core/session-control-db.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

it("prints debug command help successfully", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-debug-command-"));
	temporaryDirectories.push(agentDir);
	const stdout: string[] = [];
	const stderr: string[] = [];

	const handled = await handleDebugCommand(["debug", "--help"], {
		agentDir,
		stderr: (text) => stderr.push(text),
		stdout: (text) => stdout.push(text),
	});

	expect(handled).toBe(true);
	expect(stdout).toEqual(["Usage: pi debug attach <session-id>\n"]);
	expect(stderr).toEqual([]);
	expect(process.exitCode).toBe(0);
});

it("attaches to the debug socket owned by the exact live session", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-debug-command-"));
	temporaryDirectories.push(agentDir);
	const sessionId = "019f689a-8260-79d9-ad2c-ce6da9a4dd05";
	writeSessionHealth(getControlDbPath(agentDir), {
		agentGeneration: 1,
		checkedGeneration: 1,
		checkLatencyMs: 0,
		checkStatus: "ok",
		lastActiveAt: "2026-07-16T00:00:00.000Z",
		lastCheckedAt: "2026-07-16T00:00:00.000Z",
		pid: 1131255,
		sessionId,
		updatedAt: "2026-07-16T00:00:00.000Z",
	});
	const attach = vi.fn().mockResolvedValue(undefined);

	const handled = await handleDebugCommand(["debug", "attach", sessionId], { agentDir, attach });

	expect(handled).toBe(true);
	expect(attach).toHaveBeenCalledWith(getDebugSocketPath(agentDir, 1131255), sessionId);
});
