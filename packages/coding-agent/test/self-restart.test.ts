import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import {
	appendSelfRestartNotice,
	applySelfRestartRequest,
	consumeSelfRestartRequest,
	ENV_SELF_RESTART_OLD_PID,
	ENV_SELF_RESTART_PROMPT,
	ENV_SELF_RESTART_REQUEST,
	ENV_SELF_RESTART_SESSION,
	restartCurrentProcess,
	spawnSelfRestart,
	waitForSelfRestartParentExit,
} from "../src/core/self-restart.ts";
import type { SessionManager } from "../src/core/session-manager.ts";

function createArgs(): Args {
	return {
		continue: true,
		diagnostics: [],
		fileArgs: ["file.txt"],
		fork: "branch",
		messages: ["old prompt"],
		noSession: true,
		resume: true,
		sessionId: "old-id",
		unknownFlags: new Map(),
	};
}

describe("self restart request", () => {
	it("ignores leaked restart session env without a restart request marker and clears it", () => {
		const env: NodeJS.ProcessEnv = {
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
			[ENV_SELF_RESTART_PROMPT]: "Restarted.",
		};

		expect(consumeSelfRestartRequest(env)).toBeUndefined();
		expect(env[ENV_SELF_RESTART_SESSION]).toBeUndefined();
		expect(env[ENV_SELF_RESTART_PROMPT]).toBeUndefined();
	});

	it("consumes an exec-in-place restart request and removes it from the environment", () => {
		const env: NodeJS.ProcessEnv = {
			[ENV_SELF_RESTART_REQUEST]: "1",
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
			[ENV_SELF_RESTART_PROMPT]: "Restarted.",
			[ENV_SELF_RESTART_OLD_PID]: "100",
		};

		const handoff = consumeSelfRestartRequest(env, 100, 1);

		expect(handoff).toEqual({ sessionFile: "/tmp/session.jsonl", prompt: "Restarted.", oldPid: 100 });
		expect(env[ENV_SELF_RESTART_REQUEST]).toBeUndefined();
		expect(env[ENV_SELF_RESTART_SESSION]).toBeUndefined();
		expect(env[ENV_SELF_RESTART_PROMPT]).toBeUndefined();
		expect(env[ENV_SELF_RESTART_OLD_PID]).toBeUndefined();
	});

	it("consumes a spawn handoff whose old pid is the parent process", () => {
		const handoff = consumeSelfRestartRequest(
			{
				[ENV_SELF_RESTART_REQUEST]: "1",
				[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
				[ENV_SELF_RESTART_OLD_PID]: "42",
			},
			100,
			42,
		);

		expect(handoff).toEqual({ sessionFile: "/tmp/session.jsonl", prompt: undefined, oldPid: 42 });
	});

	it("discards a restart request leaked from an unrelated process", () => {
		const handoff = consumeSelfRestartRequest(
			{
				[ENV_SELF_RESTART_REQUEST]: "1",
				[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
				[ENV_SELF_RESTART_OLD_PID]: "9999",
			},
			100,
			42,
		);

		expect(handoff).toBeUndefined();
	});

	it("does not override startup args without a consumed request", () => {
		const args = createArgs();

		applySelfRestartRequest(args, undefined);

		expect(args.session).toBeUndefined();
		expect(args.messages).toEqual(["old prompt"]);
		expect(args.fileArgs).toEqual(["file.txt"]);
	});

	it("resumes the requested session without injecting a prompt when none is provided", () => {
		const args = createArgs();

		applySelfRestartRequest(args, { sessionFile: "/tmp/session.jsonl" });

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual([]);
		expect(args.fileArgs).toEqual([]);
	});

	it("overrides startup args to continue the requested session and injects the restart prompt", () => {
		const args = createArgs();

		applySelfRestartRequest(args, { sessionFile: "/tmp/session.jsonl", prompt: "Restarted." });

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual(["Restarted."]);
		expect(args.fileArgs).toEqual([]);
		expect(args.continue).toBe(true);
		expect(args.resume).toBe(false);
		expect(args.fork).toBeUndefined();
		expect(args.noSession).toBe(false);
		expect(args.sessionId).toBeUndefined();
	});

	it("appends a restarted notice with the current PID after an exec-in-place restart", () => {
		const notices: string[] = [];
		const sessionManager = {
			appendCustomMessageEntry: (_type: string, content: string) => {
				notices.push(content);
			},
		} as unknown as SessionManager;

		appendSelfRestartNotice(sessionManager, {
			sessionFile: "/tmp/session.jsonl",
			prompt: "Restarted.",
			oldPid: process.pid,
		});

		expect(notices).toEqual([`Restarted. PID: ${process.pid}.`]);
	});

	it("appends a restarted notice with the old and new PID after a spawn handoff", () => {
		const notices: string[] = [];
		const sessionManager = {
			appendCustomMessageEntry: (_type: string, content: string) => {
				notices.push(content);
			},
		} as unknown as SessionManager;

		appendSelfRestartNotice(sessionManager, {
			sessionFile: "/tmp/session.jsonl",
			prompt: "Restarted.",
			oldPid: 1234,
		});

		expect(notices).toEqual([`Restarted. PID 1234 -> ${process.pid}.`]);
	});

	it("waits for the old parent process before continuing restarted startup", async () => {
		let aliveChecks = 0;
		let sleeps = 0;

		await waitForSelfRestartParentExit(
			{ sessionFile: "/tmp/session.jsonl", oldPid: 1234 },
			{
				currentPid: 100,
				isProcessAlive: (pid) => {
					expect(pid).toBe(1234);
					aliveChecks += 1;
					return aliveChecks < 3;
				},
				now: () => sleeps,
				sleep: async (ms) => {
					expect(ms).toBe(25);
					sleeps += 1;
				},
			},
		);

		expect(aliveChecks).toBe(3);
		expect(sleeps).toBe(2);
	});

	it("skips the parent exit wait after an exec-in-place restart", async () => {
		let aliveChecks = 0;

		await waitForSelfRestartParentExit(
			{ sessionFile: "/tmp/session.jsonl", oldPid: 100 },
			{
				currentPid: 100,
				isProcessAlive: () => {
					aliveChecks += 1;
					return true;
				},
			},
		);

		expect(aliveChecks).toBe(0);
	});

	it("skips the parent exit wait when no restart request was consumed", async () => {
		let aliveChecks = 0;

		await waitForSelfRestartParentExit(undefined, {
			isProcessAlive: () => {
				aliveChecks += 1;
				return true;
			},
		});

		expect(aliveChecks).toBe(0);
	});

	it("replaces the process image in place with the same argv and a restart request env", async () => {
		let execveCall: { file: string; args?: readonly string[]; env?: NodeJS.ProcessEnv } | undefined;

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{
					argv: ["/usr/bin/node", "/repo/packages/coding-agent/src/cli.ts", "--flag"],
					argv0: "pi",
					execArgv: ["--import", "file:///repo/node_modules/tsx/dist/loader.mjs"],
					execve: (file, args, env) => {
						execveCall = { file, args, env };
					},
				},
			),
		).rejects.toThrow("execve returned after replacing the process image");

		expect(execveCall?.file).toBe(process.execPath);
		expect(execveCall?.args).toEqual([
			"pi",
			"--import",
			"file:///repo/node_modules/tsx/dist/loader.mjs",
			"/repo/packages/coding-agent/src/cli.ts",
			"--flag",
		]);
		expect(execveCall?.env?.[ENV_SELF_RESTART_REQUEST]).toBe("1");
		expect(execveCall?.env?.[ENV_SELF_RESTART_SESSION]).toBe("/tmp/session.jsonl");
		expect(execveCall?.env?.[ENV_SELF_RESTART_PROMPT]).toBe("Restarted.");
		expect(execveCall?.env?.[ENV_SELF_RESTART_OLD_PID]).toBe(process.pid.toString());
	});

	it("does not pass Bun virtual entrypoint paths back to compiled binaries when exec restarting", async () => {
		let execveArgs: readonly string[] | undefined;

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl" },
				{
					argv: ["/usr/bin/pi", "/$bunfs/root/pi", "/$bunfs/root/pi"],
					argv0: "pi",
					execArgv: [],
					execve: (_file, args) => {
						execveArgs = args;
					},
				},
			),
		).rejects.toThrow("execve returned after replacing the process image");

		expect(execveArgs).toEqual(["pi"]);
	});

	it("spawns a replacement process and exits when process.execve is unavailable", async () => {
		const calls: string[] = [];
		const waitForExitValues: (boolean | undefined)[] = [];

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{
					execve: undefined,
					spawnSelfRestart: async (request, restartDependencies) => {
						calls.push(`${request.sessionFile}:${request.prompt}:${request.oldPid}`);
						waitForExitValues.push(restartDependencies?.waitForExit);
						return 0;
					},
					exit: (code) => {
						throw new Error(`exit:${code}`);
					},
				},
			),
		).rejects.toThrow("exit:0");

		expect(calls).toEqual([`/tmp/session.jsonl:Restarted.:${process.pid}`]);
		expect(waitForExitValues).toEqual([false]);
	});

	it("can keep the parent process alive until the restarted child exits", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		let spawnArgs: readonly string[] | undefined;
		let spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown } | undefined;
		let unrefCalled = false;
		child.unref = () => {
			unrefCalled = true;
		};

		const exitPromise = spawnSelfRestart(
			{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
			{
				argv: ["/usr/bin/node", "/repo/packages/coding-agent/src/cli.ts", "--flag"],
				execArgv: ["--import", "file:///repo/node_modules/tsx/dist/loader.mjs"],
				spawn: (_command, args, options) => {
					spawnArgs = args;
					spawnOptions = options;
					return child;
				},
			},
		);
		child.emit("exit", 7);

		await expect(exitPromise).resolves.toBe(7);
		expect(unrefCalled).toBe(false);
		expect(spawnArgs).toEqual([
			"--import",
			"file:///repo/node_modules/tsx/dist/loader.mjs",
			"/repo/packages/coding-agent/src/cli.ts",
			"--flag",
		]);
		expect(spawnOptions?.cwd).toBe(process.cwd());
		expect(spawnOptions?.stdio).toBe("inherit");
		expect(spawnOptions?.env?.[ENV_SELF_RESTART_REQUEST]).toBe("1");
		expect(spawnOptions?.env?.[ENV_SELF_RESTART_SESSION]).toBe("/tmp/session.jsonl");
		expect(spawnOptions?.env?.[ENV_SELF_RESTART_PROMPT]).toBe("Restarted.");
		expect(spawnOptions?.env?.[ENV_SELF_RESTART_OLD_PID]).toBe(process.pid.toString());
	});

	it("rejects when the restarted child fails to spawn", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		const spawnError = new Error("spawn failed");
		child.unref = () => {};

		const exitPromise = spawnSelfRestart(
			{ sessionFile: "/tmp/session.jsonl" },
			{
				spawn: () => child,
			},
		);
		child.emit("error", spawnError);

		await expect(exitPromise).rejects.toThrow("spawn failed");
	});

	it("can return immediately after spawning the restarted child", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		let unrefCalled = false;
		child.unref = () => {
			unrefCalled = true;
		};

		const exitPromise = spawnSelfRestart(
			{ sessionFile: "/tmp/session.jsonl" },
			{
				spawn: () => child,
				waitForExit: false,
			},
		);

		await expect(exitPromise).resolves.toBe(0);
		expect(unrefCalled).toBe(true);
	});
});
