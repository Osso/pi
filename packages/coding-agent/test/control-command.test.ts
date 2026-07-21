import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleControlCommand } from "../src/cli/control-command.ts";
import {
	claimLatestIncomingMessage,
	getControlDbPath,
	writeLastMessage,
	writeSessionHealth,
} from "../src/core/session-control-db.ts";

describe("control command", () => {
	let agentDir: string;
	let stdout: string[];
	let stderr: string[];
	let signalProcess: ReturnType<typeof vi.fn<(pid: number, signal: NodeJS.Signals) => void>>;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-control-command-"));
		vi.stubEnv("PI_CODING_AGENT_STATE_DIR", agentDir);
		stdout = [];
		stderr = [];
		signalProcess = vi.fn();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { force: true, recursive: true });
	});

	it("queues a control message and signals a running process", () => {
		const handled = handleControlCommand(["control", "send", "--pid", "1234", "finish now"], {
			signalProcess,
			stderr: (text) => stderr.push(text),
			stdout: (text) => stdout.push(text),
		});

		expect(handled).toBe(true);
		expect(stdout).toEqual(["queued 1\n", "signaled 1234\n"]);
		expect(stderr).toEqual([]);
		expect(signalProcess).toHaveBeenCalledWith(1234, "SIGHUP");
		expect(claimLatestIncomingMessage(getControlDbPath(agentDir))?.content).toBe("finish now");
	});

	it("restarts a running session by exact session ID", () => {
		const sessionId = "019f626e-bd57-7f89-ae55-9541228b8edb";
		writeSessionHealth(getControlDbPath(agentDir), {
			agentGeneration: 5,
			checkedGeneration: 5,
			checkLatencyMs: 0,
			checkStatus: "ok",
			lastActiveAt: "2026-07-15T00:48:35.798Z",
			lastCheckedAt: "2026-07-15T00:48:35.798Z",
			pid: 870429,
			sessionId,
			updatedAt: "2026-07-15T00:48:35.798Z",
		});

		const handled = handleControlCommand(["control", "restart", "--session-id", sessionId], {
			signalProcess,
			stderr: (text) => stderr.push(text),
			stdout: (text) => stdout.push(text),
		});

		expect(handled).toBe(true);
		expect(stdout).toEqual([`signaled session ${sessionId} (pid 870429)\n`]);
		expect(stderr).toEqual([]);
		expect(signalProcess).toHaveBeenCalledWith(870429, "SIGHUP");
	});

	it("prints the last assistant reply", () => {
		writeLastMessage(getControlDbPath(agentDir), { role: "assistant", content: "done" });

		const handled = handleControlCommand(["control", "last"], {
			signalProcess,
			stderr: (text) => stderr.push(text),
			stdout: (text) => stdout.push(text),
		});

		expect(handled).toBe(true);
		expect(stdout).toEqual(["done\n"]);
		expect(stderr).toEqual([]);
	});

	it("prints the state-root control database path", () => {
		const handled = handleControlCommand(["control", "path"], {
			signalProcess,
			stderr: (text) => stderr.push(text),
			stdout: (text) => stdout.push(text),
		});

		expect(handled).toBe(true);
		expect(stdout).toEqual([`${getControlDbPath()}\n`]);
		expect(stderr).toEqual([]);
	});

	it("ignores non-control commands", () => {
		const handled = handleControlCommand(["--help"], {
			signalProcess,
			stderr: (text) => stderr.push(text),
			stdout: (text) => stdout.push(text),
		});

		expect(handled).toBe(false);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual([]);
	});
});
