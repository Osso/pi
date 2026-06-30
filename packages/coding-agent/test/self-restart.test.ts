import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import {
	appendSelfRestartNotice,
	applySelfRestartRequest,
	ENV_SELF_RESTART_OLD_PID,
	ENV_SELF_RESTART_PROMPT,
	ENV_SELF_RESTART_SESSION,
	restartCurrentProcess,
	spawnSelfRestart,
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

function restoreEnv(name: string, oldValue: string | undefined): void {
	if (oldValue === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = oldValue;
}

describe("self restart request", () => {
	it("resumes the requested session without injecting a prompt when none is provided", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
		});

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual([]);
		expect(args.fileArgs).toEqual([]);
	});

	it("overrides startup args to continue the requested session and injects the restart prompt", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
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

	it("keeps the parent process alive until the restarted child exits", async () => {
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
		expect(spawnArgs).toEqual(process.argv.slice(1));
		expect(spawnOptions?.cwd).toBe(process.cwd());
		expect(spawnOptions?.stdio).toBe("inherit");
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

	it("spawns a replacement process and exits the original process", async () => {
		const calls: string[] = [];

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{
					spawnSelfRestart: async (request) => {
						calls.push(`${request.sessionFile}:${request.prompt}:${request.oldPid}`);
						return 0;
					},
					exit: (code) => {
						throw new Error(`exit:${code}`);
					},
				},
			),
		).rejects.toThrow("exit:0");

		expect(calls).toEqual([`/tmp/session.jsonl:Restarted.:${process.pid}`]);
	});

	it("ignores wrapper restart env vars and still uses direct spawn", async () => {
		const oldExitCode = process.env.PI_RESTART_EXIT_CODE;
		const oldRequestFile = process.env.PI_RESTART_REQUEST_FILE;
		const calls: string[] = [];

		process.env.PI_RESTART_EXIT_CODE = "75";
		process.env.PI_RESTART_REQUEST_FILE = "/tmp/restart.json";
		try {
			await expect(
				restartCurrentProcess(
					{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
					{
						spawnSelfRestart: async (request) => {
							calls.push(`${request.sessionFile}:${request.prompt}:${request.oldPid}`);
							return 0;
						},
						exit: (code) => {
							throw new Error(`exit:${code}`);
						},
					},
				),
			).rejects.toThrow("exit:0");
		} finally {
			restoreEnv("PI_RESTART_EXIT_CODE", oldExitCode);
			restoreEnv("PI_RESTART_REQUEST_FILE", oldRequestFile);
		}

		expect(calls).toEqual([`/tmp/session.jsonl:Restarted.:${process.pid}`]);
	});
});
