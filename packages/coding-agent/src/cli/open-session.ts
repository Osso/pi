import { existsSync } from "node:fs";
import chalk from "chalk";
import { restoreArchivedSession } from "../core/session-archive-storage.ts";
import { SessionManager } from "../core/session-manager.ts";
import { readSessionTranscriptPath } from "../core/session-transcript.ts";

function exitWithError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

/**
 * Open a startup session or exit. `requireTranscript` is set for ID matches from the session index: a removed
 * transcript must fail instead of starting a new session in its place, as an explicit new path does.
 */
export function openSessionOrExit(
	path: string,
	sessionDir: string | undefined,
	controlDbPath: string | undefined,
	requireTranscript = false,
): SessionManager {
	try {
		if (requireTranscript && !existsSync(readSessionTranscriptPath(path))) {
			throw new Error(`Session transcript is missing: ${path}`);
		}
		const restoredPath = controlDbPath ? restoreArchivedSession(controlDbPath, path) : path;
		return SessionManager.open(restoredPath, sessionDir);
	} catch (error: unknown) {
		exitWithError(error);
	}
}

export function forkSessionOrExit(
	sourcePath: string,
	cwd: string,
	sessionDir?: string,
	sessionId?: string,
): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		exitWithError(error);
	}
}
