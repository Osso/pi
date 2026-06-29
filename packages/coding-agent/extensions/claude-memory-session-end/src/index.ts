import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_HOOK = "/home/osso/bin/claude-memory-hook";
const DEFAULT_LOG = "/tmp/claude-memory-hook.log";

type HookPayload = {
	transcript_path: string;
	source: "pi";
	event: "session_shutdown";
	reason?: string;
};

function resolveHookCommand(): string | undefined {
	const configuredCommand = process.env.PI_CLAUDE_MEMORY_SESSION_END_HOOK;
	if (configuredCommand) {
		return configuredCommand;
	}

	if (existsSync(DEFAULT_HOOK)) {
		return DEFAULT_HOOK;
	}

	return undefined;
}

function runHook(command: string, payload: HookPayload): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [], {
			stdio: ["pipe", "ignore", "ignore"],
			detached: true,
			env: {
				...process.env,
				CLAUDE_MEMORY_HOOK_LOG: process.env.CLAUDE_MEMORY_HOOK_LOG ?? DEFAULT_LOG,
			},
		});

		child.once("error", reject);
		child.once("spawn", () => {
			child.stdin.end(`${JSON.stringify(payload)}\n`);
			child.unref();
			resolve();
		});
	});
}

export default function claudeMemorySessionEndExtension(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			return;
		}

		const command = resolveHookCommand();
		if (!command) {
			return;
		}

		await runHook(command, {
			transcript_path: sessionFile,
			source: "pi",
			event: "session_shutdown",
			reason: event.reason,
		});
	});
}
