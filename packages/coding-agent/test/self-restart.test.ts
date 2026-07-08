import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import {
	appendSelfRestartNotice,
	applySelfRestartRequest,
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
	it("ignores leaked restart session env without a restart request marker", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
			[ENV_SELF_RESTART_PROMPT]: "Restarted.",
		});

		expect(args.session).toBeUndefined();
		expect(args.messages).toEqual(["old prompt"]);
		expect(args.fileArgs).toEqual(["file.txt"]);
	});

	it("resumes the requested session without injecting a prompt when none is provided", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
			[ENV_SELF_RESTART_REQUEST]: "1",
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
		});

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual([]);
		expect(args.fileArgs).toEqual([]);
	});

	it("overrides startup args to continue the requested session and injects the restart prompt", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
			[ENV_SELF_RESTART_REQUEST]: "1",
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
			[ENV_SELF_RESTART_PROMPT]: "Restarted.",
		});

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual(["Restarted."]);
		expect(args.fileArgs).toEqual([]);
		expect(args.continue).toBe(true);
		expect(args.resume).toBe(false);
		expect(args.fork).toBeUndefined();
		expect(args.noSession).toBe(false);
		expect(args.sessionId).toBeUndefined();
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

	it("does not pass Bun virtual entrypoint paths back to compiled binaries", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		let spawnArgs: readonly string[] | undefined;
		child.unref = () => {};

		const exitPromise = spawnSelfRestart(
			{ sessionFile: "/tmp/session.jsonl" },
			{
				argv: ["/usr/bin/pi", "/$bunfs/root/pi", "/$bunfs/root/pi"],
				execArgv: [],
				spawn: (_command, args) => {
					spawnArgs = args;
					return child;
				},
			},
		);
		child.emit("exit", 0);

		await expect(exitPromise).resolves.toBe(0);
		expect(spawnArgs).toEqual([]);
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

	it("appends a restarted notice with the old and new PID", () => {
		const notices: string[] = [];
		const sessionManager = {
			appendCustomMessageEntry: (_type: string, content: string) => {
				notices.push(content);
			},
		} as unknown as SessionManager;

		appendSelfRestartNotice(sessionManager, {
			[ENV_SELF_RESTART_PROMPT]: "Restarted.",
			[ENV_SELF_RESTART_OLD_PID]: "1234",
		});

		expect(notices).toEqual([`Restarted. PID 1234 -> ${process.pid}.`]);
	});

	it("waits for the old parent process before continuing restarted startup", async () => {
		let aliveChecks = 0;
		let sleeps = 0;

		await waitForSelfRestartParentExit({
			env: {
				[ENV_SELF_RESTART_REQUEST]: "1",
				[ENV_SELF_RESTART_OLD_PID]: "1234",
			},
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
		});

		expect(aliveChecks).toBe(3);
		expect(sleeps).toBe(2);
	});

	it("skips parent exit wait when no self-restart request is active", async () => {
		let aliveChecks = 0;

		await waitForSelfRestartParentExit({
			env: {
				[ENV_SELF_RESTART_OLD_PID]: "1234",
			},
			isProcessAlive: () => {
				aliveChecks += 1;
				return true;
			},
		});

		expect(aliveChecks).toBe(0);
	});

	it("spawns a replacement process without waiting and exits the original process", async () => {
		const calls: string[] = [];
		const waitForExitValues: (boolean | undefined)[] = [];

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{
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
});
