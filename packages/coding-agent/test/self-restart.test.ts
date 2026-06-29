import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import {
	applySelfRestartRequest,
	ENV_RESTART_EXIT_CODE,
	ENV_RESTART_REQUEST_FILE,
	ENV_SELF_RESTART_PROMPT,
	ENV_SELF_RESTART_SESSION,
	getRestartExitCode,
	restartCurrentProcess,
	spawnSelfRestart,
	writeWrapperRestartRequest,
} from "../src/core/self-restart.ts";

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
	it("reads a wrapper restart exit code from the environment", () => {
		expect(getRestartExitCode({ [ENV_RESTART_EXIT_CODE]: "75" })).toBe(75);
		expect(getRestartExitCode({})).toBeUndefined();
	});

	it("rejects invalid wrapper restart exit codes", () => {
		expect(() => getRestartExitCode({ [ENV_RESTART_EXIT_CODE]: "0" })).toThrow("integer from 1 to 255");
		expect(() => getRestartExitCode({ [ENV_RESTART_EXIT_CODE]: "300" })).toThrow("integer from 1 to 255");
		expect(() => getRestartExitCode({ [ENV_RESTART_EXIT_CODE]: "nope" })).toThrow("integer from 1 to 255");
	});

	it("resumes the requested session without injecting a prompt when none is provided", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
		});

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual([]);
		expect(args.fileArgs).toEqual([]);
	});

	it("overrides startup args to resume the requested session with the restart prompt", () => {
		const args = createArgs();

		applySelfRestartRequest(args, {
			[ENV_SELF_RESTART_SESSION]: "/tmp/session.jsonl",
			[ENV_SELF_RESTART_PROMPT]: "Restarted.",
		});

		expect(args.session).toBe("/tmp/session.jsonl");
		expect(args.messages).toEqual(["Restarted."]);
		expect(args.fileArgs).toEqual([]);
		expect(args.continue).toBe(false);
		expect(args.resume).toBe(false);
		expect(args.fork).toBeUndefined();
		expect(args.noSession).toBe(false);
		expect(args.sessionId).toBeUndefined();
	});

	it("writes restart requests for wrapper-managed process restarts", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-self-restart-"));
		try {
			const requestFile = join(dir, "restart.json");

			writeWrapperRestartRequest(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{ [ENV_RESTART_REQUEST_FILE]: requestFile },
			);

			expect(JSON.parse(readFileSync(requestFile, "utf8"))).toEqual({
				sessionFile: "/tmp/session.jsonl",
				prompt: "Restarted.",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores wrapper restart requests when no request file is configured", () => {
		expect(() => writeWrapperRestartRequest({ sessionFile: "/tmp/session.jsonl" }, {})).not.toThrow();
	});

	it("keeps the parent process alive until the restarted child exits", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: () => void };
		let spawnArgs: readonly string[] | undefined;
		let spawnOptions: { env?: NodeJS.ProcessEnv; stdio?: unknown } | undefined;
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
		expect(spawnOptions?.stdio).toBe("inherit");
		expect(spawnOptions?.env?.[ENV_SELF_RESTART_SESSION]).toBe("/tmp/session.jsonl");
		expect(spawnOptions?.env?.[ENV_SELF_RESTART_PROMPT]).toBe("Restarted.");
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
		child.unref = () => {};

		const exitPromise = spawnSelfRestart(
			{ sessionFile: "/tmp/session.jsonl" },
			{
				spawn: () => child,
				waitForExit: false,
			},
		);

		await expect(exitPromise).resolves.toBe(0);
	});

	it("exits with the wrapper restart code after persisting the notice", async () => {
		const calls: string[] = [];

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{
					env: { [ENV_RESTART_EXIT_CODE]: "75" },
					appendNotice: () => {
						calls.push("append");
					},
					dispose: async () => {
						calls.push("dispose");
					},
					exit: (code) => {
						throw new Error(`exit:${code}`);
					},
				},
			),
		).rejects.toThrow("exit:75");

		expect(calls).toEqual(["append", "dispose"]);
	});

	it("spawns a replacement process when no wrapper restart code is available", async () => {
		const calls: string[] = [];

		await expect(
			restartCurrentProcess(
				{ sessionFile: "/tmp/session.jsonl", prompt: "Restarted." },
				{
					env: {},
					dispose: async () => {
						calls.push("dispose");
					},
					spawnSelfRestart: async (request) => {
						calls.push(`${request.sessionFile}:${request.prompt}`);
						return 7;
					},
					exit: (code) => {
						throw new Error(`exit:${code}`);
					},
				},
			),
		).rejects.toThrow("exit:7");

		expect(calls).toEqual(["dispose", "/tmp/session.jsonl:Restarted."]);
	});
});
