import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Args } from "../src/cli/args.ts";
import {
	applySelfRestartRequest,
	ENV_SELF_RESTART_PROMPT,
	ENV_SELF_RESTART_SESSION,
	spawnSelfRestart,
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
});
