import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLAUDE_MEMORY = "/home/osso/.cargo/bin/claude-memory";

function formatLogLine(message: string): string {
	return `[${new Date().toISOString()}] ${message}\n`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendLogLine(logPath: string, message: string): void {
	mkdirSync(dirname(logPath), { recursive: true });
	appendFileSync(logPath, formatLogLine(message));
}

function reportLaunchFailure(logPath: string, sessionPath: string, error: unknown): void {
	const message = `failed to launch index-file for session ${sessionPath}: ${errorMessage(error)}`;
	try {
		appendLogLine(logPath, message);
	} catch (logError) {
		console.error(`${message}; failed to write ${logPath}: ${errorMessage(logError)}`);
	}
}

function launchIndex(sessionPath: string): void {
	const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
	const logPath = join(cacheHome, "claude-memory", "pi-index.log");
	mkdirSync(dirname(logPath), { recursive: true });
	const logFile = openSync(logPath, "a");

	try {
		appendFileSync(logFile, formatLogLine(`starting index-file for session ${sessionPath}`));
		const child = spawn(CLAUDE_MEMORY, ["index-file", sessionPath], {
			detached: true,
			stdio: ["ignore", logFile, logFile],
		});
		child.once("error", (error) => reportLaunchFailure(logPath, sessionPath, error));
		child.unref();
	} catch (error) {
		reportLaunchFailure(logPath, sessionPath, error);
	} finally {
		closeSync(logFile);
	}
}

export default function claudeMemorySessionEndExtension(pi: ExtensionAPI): void {
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true) return;

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			return;
		}

		launchIndex(sessionFile);
	});
}
