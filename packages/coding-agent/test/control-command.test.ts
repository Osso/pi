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
	let livePiPids: Set<number>;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-control-command-"));
		vi.stubEnv("PI_CODING_AGENT_STATE_DIR", agentDir);
		stdout = [];
		stderr = [];
		signalProcess = vi.fn();
		livePiPids = new Set();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { force: true, recursive: true });
	});

	function recordRunningSession(sessionId: string, pid: number): void {
		livePiPids.add(pid);
		writeSessionHealth(getControlDbPath(agentDir), {
			agentGeneration: 1,
			checkedGeneration: 1,
			checkLatencyMs: 0,
			checkStatus: "ok",
			lastActiveAt: "2026-11-07T08:45:00.000Z",
			lastCheckedAt: "2026-11-07T08:45:00.000Z",
			pid,
			sessionId,
			updatedAt: "2026-11-07T08:45:00.000Z",
		});
	}

	function send(...args: string[]): void {
		handleControlCommand(["control", "send", ...args], {
			isPiProcess: (pid) => livePiPids.has(pid),
			signalProcess,
			stderr: (text) => stderr.push(text),
			stdout: (text) => stdout.push(text),
		});
	}

	it("queues a control message for the session of the signaled process", () => {
		recordRunningSession("session-1234", 1234);

		send("--pid", "1234", "finish now");

		expect(stdout).toEqual(["queued 1 for session session-1234\n", "signaled 1234\n"]);
		expect(stderr).toEqual([]);
		expect(signalProcess).toHaveBeenCalledWith(1234, "SIGHUP");
		expect(claimLatestIncomingMessage(getControlDbPath(agentDir), "other-session")).toBeUndefined();
		expect(claimLatestIncomingMessage(getControlDbPath(agentDir), "session-1234")?.content).toBe("finish now");
	});

	it("delivers concurrent sends to three processes to their own sessions", () => {
		for (const pid of [101, 102, 103]) recordRunningSession(`session-${pid}`, pid);

		for (const pid of [101, 102, 103]) send("--pid", String(pid), `instruction for ${pid}`);

		const controlDbPath = getControlDbPath(agentDir);
		for (const pid of [103, 101, 102]) {
			expect(claimLatestIncomingMessage(controlDbPath, `session-${pid}`)?.content).toBe(`instruction for ${pid}`);
		}
	});

	it("rejects a pid with no running session without queuing or signaling", () => {
		const previousExitCode = process.exitCode;
		try {
			send("--pid", "4321", "finish now");

			expect(stdout).toEqual([]);
			expect(stderr).toEqual(["No running Pi session has pid 4321.\n"]);
			expect(process.exitCode).toBe(1);
			expect(signalProcess).not.toHaveBeenCalled();
			expect(claimLatestIncomingMessage(getControlDbPath(agentDir), "any-session")).toBeUndefined();
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("rejects a healthy session row whose process is no longer a live Pi process", () => {
		const previousExitCode = process.exitCode;
		try {
			recordRunningSession("exited-session", 5555);
			livePiPids.delete(5555);

			send("--pid", "5555", "finish now");

			expect(stderr).toEqual(["No running Pi session has pid 5555.\n"]);
			expect(signalProcess).not.toHaveBeenCalled();
			expect(claimLatestIncomingMessage(getControlDbPath(agentDir), "exited-session")).toBeUndefined();
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("queues an unaddressed message for any session when no pid is given", () => {
		send("finish now");

		expect(stdout).toEqual(["queued 1\n"]);
		expect(signalProcess).not.toHaveBeenCalled();
		expect(claimLatestIncomingMessage(getControlDbPath(agentDir), "any-session")?.content).toBe("finish now");
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

	it("treats send -h/--help as a help request instead of a prompt", () => {
		const previousExitCode = process.exitCode;
		try {
			for (const args of [
				["control", "send", "--help"],
				["control", "send", "-h"],
				["control", "send", "--pid", "1234", "--help"],
			]) {
				stdout = [];
				const handled = handleControlCommand(args, {
					signalProcess,
					stderr: (text) => stderr.push(text),
					stdout: (text) => stdout.push(text),
				});

				expect(handled).toBe(true);
				expect(stdout).toEqual([
					"Usage:\n  pi control send [--pid <pid>] <message>\n  pi control restart --session-id <session-id>\n  pi control last\n  pi control path\n",
				]);
				expect(stderr).toEqual([]);
				expect(process.exitCode).toBe(0);
				expect(signalProcess).not.toHaveBeenCalled();
				expect(claimLatestIncomingMessage(getControlDbPath(agentDir), "any-session")).toBeUndefined();
			}
		} finally {
			process.exitCode = previousExitCode;
		}
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
