import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

vi.unmock("node:child_process");

import claudeMemoryEnrichExtension from "../extensions/claude-memory-enrich/src/index.ts";

type BeforeAgentStartHandler = (
	event: { prompt: string; systemPrompt: string },
	ctx: { signal: AbortSignal },
) => Promise<{ systemPrompt: string } | undefined>;

function registerBeforeAgentStartHandler(): BeforeAgentStartHandler {
	let handler: BeforeAgentStartHandler | undefined;
	const pi = {
		on(event: string, registeredHandler: BeforeAgentStartHandler) {
			if (event === "before_agent_start") handler = registeredHandler;
		},
	} as unknown as ExtensionAPI;
	claudeMemoryEnrichExtension(pi);
	if (!handler) throw new Error("before_agent_start handler not registered");
	return handler;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("claude-memory enrich real child lifecycle", () => {
	let previousCommand: string | undefined;
	let temporaryDirectory: string | undefined;
	let childPid: number | undefined;

	beforeEach(() => {
		previousCommand = process.env.PI_CLAUDE_MEMORY;
		temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-claude-memory-enrich-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (childPid !== undefined && processExists(childPid)) process.kill(childPid, "SIGKILL");
		if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
		if (previousCommand === undefined) delete process.env.PI_CLAUDE_MEMORY;
		else process.env.PI_CLAUDE_MEMORY = previousCommand;
	});

	it("reaps a child that ignores SIGTERM before the handler settles", async () => {
		if (!temporaryDirectory) throw new Error("Temporary directory was not created");
		const pidPath = join(temporaryDirectory, "child.pid");
		const scriptPath = join(temporaryDirectory, "claude-memory");
		writeFileSync(
			scriptPath,
			`#!/usr/bin/env node\n` +
				`const { writeFileSync } = require("node:fs");\n` +
				`writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n` +
				`process.stdin.resume();\n` +
				`process.on("SIGTERM", () => {});\n` +
				`setInterval(() => {}, 1_000);\n`,
		);
		chmodSync(scriptPath, 0o755);
		process.env.PI_CLAUDE_MEMORY = scriptPath;
		expect(process.env.PI_CLAUDE_MEMORY).toBe(scriptPath);

		const originalSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
			originalSetTimeout(callback, delay === 75_000 ? 100 : delay === 1_000 ? 20 : delay, ...args),
		);
		const handler = registerBeforeAgentStartHandler();
		const result = handler(
			{ prompt: "reap this child", systemPrompt: "system" },
			{ signal: new AbortController().signal },
		);

		await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), { timeout: 2_000 });
		childPid = Number(readFileSync(pidPath, "utf8"));
		await expect(result).resolves.toBeUndefined();
		expect(processExists(childPid)).toBe(false);
	});
});
