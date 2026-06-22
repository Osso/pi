import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolCallEvent, ToolCallEventResult } from "../extensions/types.ts";

const DEFAULT_HOOK_PATH = "/home/osso/.cargo/bin/claude-bash-hook";
const HOOK_TIMEOUT_MS = 30_000;

type ClaudeBashHookOptions = {
	cwd: string;
	approvalPolicy: string;
};

type HookSpecificOutput = {
	permissionDecision?: unknown;
	permissionDecisionReason?: unknown;
	updatedInput?: unknown;
};

type HookProcessResult = {
	stdout: string;
	stderr: string;
};

export type ClaudeBashHookReviewResult =
	| { action: "allow" }
	| { action: "ask"; reason: string }
	| { action: "block"; result: ToolCallEventResult }
	| { action: "unavailable" };

export function canRunClaudeBashHook(): boolean {
	return resolveClaudeBashHookCommand() !== undefined;
}

export async function reviewBashWithClaudeBashHook(
	event: ToolCallEvent,
	options: ClaudeBashHookOptions,
): Promise<ClaudeBashHookReviewResult> {
	if (event.toolName !== "bash") {
		return { action: "unavailable" };
	}

	const command = typeof event.input.command === "string" ? event.input.command : undefined;
	if (!command) {
		return { action: "unavailable" };
	}

	const hookCommand = resolveClaudeBashHookCommand();
	if (!hookCommand) {
		return { action: "unavailable" };
	}

	const hookInput = {
		access_mode: "supervised",
		approval_policy: options.approvalPolicy,
		cwd: options.cwd,
		supports_updated_input: true,
		tool_input: { ...event.input, cwd: options.cwd },
		tool_name: "Bash",
	};

	const result = await runHookProcess(hookCommand, hookInput);
	const hookOutput = parseHookSpecificOutput(result.stdout);
	if (!hookOutput) {
		return { action: "unavailable" };
	}

	const decision = hookOutput.permissionDecision;
	if (decision === "allow") {
		if (isRecord(hookOutput.updatedInput)) {
			replaceInputInPlace(event.input, hookOutput.updatedInput);
		}
		return { action: "allow" };
	}

	if (decision === "deny" || decision === "block") {
		return {
			action: "block",
			result: { block: true, reason: formatHookBlockReason(hookOutput.permissionDecisionReason) },
		};
	}

	if (decision === "ask") {
		return { action: "ask", reason: formatHookBlockReason(hookOutput.permissionDecisionReason) };
	}

	return { action: "unavailable" };
}

function resolveClaudeBashHookCommand(): string | undefined {
	const configuredCommand = process.env.PI_CLAUDE_BASH_HOOK;
	if (configuredCommand) {
		return configuredCommand;
	}

	if (existsSync(DEFAULT_HOOK_PATH)) {
		return DEFAULT_HOOK_PATH;
	}

	return undefined;
}

function runHookProcess(command: string, input: unknown): Promise<HookProcessResult> {
	return new Promise((resolve, reject) => {
		const abortController = new AbortController();
		const timeout = setTimeout(() => abortController.abort(), HOOK_TIMEOUT_MS);
		const child = spawn(command, ["--harness", "codex"], {
			signal: abortController.signal,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			if (isMissingHookError(error)) {
				resolve({ stdout: "", stderr: "" });
				return;
			}
			reject(error);
		});
		child.on("close", () => {
			clearTimeout(timeout);
			resolve({ stdout, stderr });
		});
		child.stdin.end(JSON.stringify(input));
	});
}

function parseHookSpecificOutput(stdout: string): HookSpecificOutput | undefined {
	const parsed = parseJsonObject(stdout.trim());
	const hookSpecificOutput = isRecord(parsed?.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined;
	return hookSpecificOutput;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (!text) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function formatHookBlockReason(reason: unknown): string {
	return typeof reason === "string" && reason.trim().length > 0 ? reason : "Blocked by claude-bash-hook";
}

function replaceInputInPlace(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const key of Object.keys(target)) {
		delete target[key];
	}
	Object.assign(target, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingHookError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}
