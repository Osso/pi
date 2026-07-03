import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const DEFAULT_HOOK_PATH = "/home/osso/.cargo/bin/claude-bash-hook";
const HOOK_TIMEOUT_MS = 30_000;

type HookSpecificOutput = {
	permissionDecision?: unknown;
	permissionDecisionReason?: unknown;
	updatedInput?: unknown;
};

type HookProcessResult = {
	stdout: string;
	stderr: string;
};

type ClaudeBashHookReviewResult =
	| { action: "allow"; updatedInput?: Record<string, unknown> }
	| { action: "ask"; reason: string }
	| { action: "deny"; reason: string }
	| { action: "unavailable" };

export default function claudeBashHookExtension(pi: ExtensionAPI): void {
	pi.registerApprovalReviewer(async (event, ctx) => {
		const result = await reviewToolWithClaudeBashHook(event, ctx.cwd);
		if (result.action === "unavailable") {
			return undefined;
		}
		return result;
	});
}

export async function reviewToolWithClaudeBashHook(
	event: ToolCallEvent,
	cwd: string,
): Promise<ClaudeBashHookReviewResult> {
	const toolName = toClaudeBashHookToolName(event.toolName);
	if (!toolName || !hasReviewableInput(toolName, event.input)) {
		return { action: "unavailable" };
	}

	const hookCommand = resolveClaudeBashHookCommand();
	if (!hookCommand) {
		return { action: "unavailable" };
	}

	const hookInput = {
		access_mode: "supervised",
		approval_policy: "on-request",
		cwd,
		supports_updated_input: true,
		tool_input: { ...event.input, cwd },
		tool_name: toolName,
	};

	const result = await runHookProcess(hookCommand, hookInput);
	const hookOutput = parseHookSpecificOutput(result.stdout);
	if (!hookOutput) {
		return { action: "unavailable" };
	}

	return mapHookOutput(hookOutput);
}

function toClaudeBashHookToolName(toolName: string): string | undefined {
	if (toolName === "bash") {
		return "Bash";
	}
	if (toolName === "hostrun_eval" || toolName === "pyrun_eval") {
		return toolName;
	}
	return undefined;
}

function hasReviewableInput(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "Bash") {
		return typeof input.command === "string" && input.command.length > 0;
	}
	return typeof input.code === "string" && input.code.length > 0;
}

function mapHookOutput(hookOutput: HookSpecificOutput): ClaudeBashHookReviewResult {
	const decision = hookOutput.permissionDecision;
	if (decision === "allow") {
		const updatedInput = isRecord(hookOutput.updatedInput) ? hookOutput.updatedInput : undefined;
		return updatedInput ? { action: "allow", updatedInput } : { action: "allow" };
	}

	if (decision === "deny" || decision === "block") {
		return { action: "deny", reason: formatHookReason(hookOutput.permissionDecisionReason) };
	}

	if (decision === "ask") {
		return { action: "ask", reason: formatHookReason(hookOutput.permissionDecisionReason) };
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
	return isRecord(parsed?.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined;
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

function formatHookReason(reason: unknown): string {
	return typeof reason === "string" && reason.trim().length > 0 ? reason : "Blocked by claude-bash-hook";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingHookError(error: Error): boolean {
	return "code" in error && error.code === "ENOENT";
}
