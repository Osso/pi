import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

type ShutdownHandler = (
	event: { reason: "quit" },
	ctx: {
		sessionManager: { getSessionFile(): string | undefined };
		multiAgentAgentId?: string;
		multiAgentRequiresAgentId?: boolean;
	},
) => void | Promise<void>;

function fakeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
	return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

async function registerShutdownHandler(): Promise<ShutdownHandler> {
	let shutdownHandler: ShutdownHandler | undefined;
	const pi = {
		on(event: string, handler: ShutdownHandler) {
			if (event === "session_shutdown") shutdownHandler = handler;
		},
	} as unknown as ExtensionAPI;
	const { default: extension } = await import("../extensions/claude-memory-session-end/src/index.ts");
	extension(pi);
	if (!shutdownHandler) throw new Error("session_shutdown handler not registered");
	return shutdownHandler;
}

describe("claude-memory session-end extension", () => {
	let cacheDirectory: string;
	let previousCacheHome: string | undefined;
	let previousLegacyHook: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
		cacheDirectory = mkdtempSync(join(tmpdir(), "pi-claude-memory-session-end-"));
		previousCacheHome = process.env.XDG_CACHE_HOME;
		previousLegacyHook = process.env.PI_CLAUDE_MEMORY_SESSION_END_HOOK;
		process.env.XDG_CACHE_HOME = cacheDirectory;
		process.env.PI_CLAUDE_MEMORY_SESSION_END_HOOK = "/obsolete/claude-memory-hook";
	});

	afterEach(() => {
		if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previousCacheHome;
		if (previousLegacyHook === undefined) delete process.env.PI_CLAUDE_MEMORY_SESSION_END_HOOK;
		else process.env.PI_CLAUDE_MEMORY_SESSION_END_HOOK = previousLegacyHook;
		rmSync(cacheDirectory, { recursive: true, force: true });
	});

	it("launches index-file detached without waiting for child completion", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const shutdownHandler = await registerShutdownHandler();
		const transcriptPath = "/tmp/pi fixture/session.jsonl";

		const outcome = await Promise.race([
			Promise.resolve(
				shutdownHandler({ reason: "quit" }, { sessionManager: { getSessionFile: () => transcriptPath } }),
			).then(() => "completed"),
			new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
		]);

		expect(outcome).toBe("completed");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [command, args, options] = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ detached: boolean; stdio: [string, number, number] },
		];
		expect(command).toBe("/home/osso/.cargo/bin/claude-memory");
		expect(args).toEqual(["index-file", transcriptPath]);
		expect(options.detached).toBe(true);
		expect(options.stdio[0]).toBe("ignore");
		expect(typeof options.stdio[1]).toBe("number");
		expect(options.stdio[2]).toBe(options.stdio[1]);
		expect(child.unref).toHaveBeenCalledOnce();

		const log = readFileSync(join(cacheDirectory, "claude-memory/pi-index.log"), "utf8");
		expect(log).toContain(`starting index-file for session ${transcriptPath}`);
	});

	it("logs spawn failures without rejecting shutdown", async () => {
		spawnMock.mockImplementation(() => {
			throw new Error("simulated spawn failure");
		});
		const shutdownHandler = await registerShutdownHandler();
		const transcriptPath = "/tmp/pi fixture/failure.jsonl";

		expect(() =>
			shutdownHandler({ reason: "quit" }, { sessionManager: { getSessionFile: () => transcriptPath } }),
		).not.toThrow();

		const log = readFileSync(join(cacheDirectory, "claude-memory/pi-index.log"), "utf8");
		expect(log).toContain(`failed to launch index-file for session ${transcriptPath}: simulated spawn failure`);
	});

	it("does not index child-agent sessions", async () => {
		const shutdownHandler = await registerShutdownHandler();
		const transcriptPath = "/tmp/pi fixture/child.jsonl";

		for (const childContext of [{ multiAgentAgentId: "agent_1" }, { multiAgentRequiresAgentId: true }]) {
			await shutdownHandler(
				{ reason: "quit" },
				{ sessionManager: { getSessionFile: () => transcriptPath }, ...childContext },
			);
		}

		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("does nothing for ephemeral sessions", async () => {
		const shutdownHandler = await registerShutdownHandler();

		await shutdownHandler({ reason: "quit" }, { sessionManager: { getSessionFile: () => undefined } });

		expect(spawnMock).not.toHaveBeenCalled();
	});
});
