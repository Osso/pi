import { getAgentDir } from "../config.ts";
import { archivePersistedSession } from "../core/session-archive-storage.ts";
import {
	archiveSessionsOlderThan,
	getControlDbPath,
	listArchivedSessionMetadata,
	type SessionMetadata,
	writeSessionMetadata,
} from "../core/session-control-db.ts";
import type { SessionInfo } from "../core/session-manager.ts";
import { SessionManager } from "../core/session-manager.ts";
import { migrateToolResultSessionFiles, type ToolResultSessionMigrationReport } from "../core/session-tool-output.ts";

interface SessionsCommandDependencies {
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	now?: () => Date;
	refreshMetadata?: (controlDbPath: string) => Promise<void>;
	archiveOlderThan?: (controlDbPath: string, cutoff: Date) => string[];
	controlDbPath?: string;
	listArchivedSessions?: (controlDbPath: string) => Array<Pick<SessionMetadata, "id" | "sessionPath">>;
	compressArchivedSession?: (controlDbPath: string, sessionPath: string) => string;
	agentDir?: string;
	truncateToolOutput?: (agentDir: string) => ToolResultSessionMigrationReport;
}

export async function handleSessionsCommand(
	args: string[],
	dependencies: SessionsCommandDependencies,
): Promise<boolean> {
	if (args[0] !== "sessions") return false;

	const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
	const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
	if (args[1] === "truncate-tool-output") {
		if (args.length !== 2) {
			printSessionsHelp(stderr);
			process.exitCode = 1;
			return true;
		}
		const report = (dependencies.truncateToolOutput ?? migrateToolResultSessionFiles)(
			dependencies.agentDir ?? getAgentDir(),
		);
		stdout(formatTruncateToolOutputReport(report));
		if (report.errors.length > 0) {
			stderr(`Migration errors:\n${report.errors.join("\n")}\n`);
			process.exitCode = 1;
		}
		return true;
	}

	if (args[1] === "compress-archived") {
		return compressArchivedSessions(args.slice(2), dependencies, stdout, stderr);
	}

	if (args[1] !== "archive") {
		printSessionsHelp(args[1] === "--help" || args[1] === "-h" ? stdout : stderr);
		process.exitCode = args[1] === "--help" || args[1] === "-h" ? 0 : 1;
		return true;
	}

	const days = parseDays(args.slice(2));
	if (days === undefined) {
		printSessionsHelp(stderr);
		process.exitCode = 1;
		return true;
	}

	const controlDbPath = dependencies.controlDbPath ?? getControlDbPath();
	if (dependencies.refreshMetadata) {
		await dependencies.refreshMetadata(controlDbPath);
	} else {
		const sessions = await SessionManager.listAll();
		for (const session of sessions) {
			writeSessionMetadata(controlDbPath, writableMetadata(session));
		}
	}

	const now = dependencies.now?.() ?? new Date();
	const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	const archived = dependencies.archiveOlderThan
		? dependencies.archiveOlderThan(controlDbPath, cutoff)
		: archiveSessionsOlderThan(controlDbPath, cutoff).map((sessionPath) =>
				archivePersistedSession(controlDbPath, sessionPath),
			);
	stdout(
		`Archived ${archived.length} session${archived.length === 1 ? "" : "s"} older than ${days} day${days === 1 ? "" : "s"}.\n`,
	);
	return true;
}

function compressArchivedSessions(
	args: string[],
	dependencies: SessionsCommandDependencies,
	stdout: (text: string) => void,
	stderr: (text: string) => void,
): boolean {
	const dryRun = parseDryRun(args);
	if (dryRun === undefined) {
		printSessionsHelp(stderr);
		process.exitCode = 1;
		return true;
	}

	const controlDbPath = dependencies.controlDbPath ?? getControlDbPath();
	const archivedSessions = (dependencies.listArchivedSessions ?? listArchivedSessionMetadata)(controlDbPath);
	const skipped = archivedSessions.filter((session) => !shouldCompressArchivedSession(session));
	const candidates = archivedSessions.filter(shouldCompressArchivedSession);
	const migratedPaths: string[] = [];
	const failures: string[] = [];
	if (!dryRun) {
		const compress = dependencies.compressArchivedSession ?? archivePersistedSession;
		for (const session of candidates) {
			try {
				migratedPaths.push(compress(controlDbPath, session.sessionPath));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${session.sessionPath}: ${message}`);
			}
		}
	}

	const migrated = dryRun ? candidates.map((session) => session.sessionPath) : migratedPaths;
	const action = dryRun ? "Would migrate" : "Migrated";
	stdout(
		`${action} ${migrated.length} archived session${migrated.length === 1 ? "" : "s"}. Skipped ${skipped.length}. Failed ${failures.length}.\n`,
	);
	if (migrated.length > 0) stdout(`${action}:\n${migrated.join("\n")}\n`);
	if (skipped.length > 0) stdout(`Skipped:\n${skipped.map((session) => session.sessionPath).join("\n")}\n`);
	if (failures.length > 0) {
		stderr(`Archived-session migration failures:\n${failures.join("\n")}\n`);
		stdout(`Failed:\n${failures.join("\n")}\n`);
		process.exitCode = 1;
	}
	return true;
}

function parseDryRun(args: string[]): boolean | undefined {
	if (args.length === 0) return false;
	return args.length === 1 && args[0] === "--dry-run" ? true : undefined;
}

function shouldCompressArchivedSession(session: Pick<SessionMetadata, "id" | "sessionPath">): boolean {
	return session.sessionPath.endsWith(".jsonl") && !isResidentSession(session);
}

function isResidentSession(session: Pick<SessionMetadata, "id" | "sessionPath">): boolean {
	return (
		session.id === "supervisor" ||
		session.id === "architect" ||
		/(?:^|[\\/])(?:supervisor-sessions|architect-sessions)(?:[\\/]|$)/.test(session.sessionPath)
	);
}

function parseDays(args: string[]): number | undefined {
	if (args.length === 0) return 5;
	if (args.length !== 2 || args[0] !== "--older-than") return undefined;
	const days = Number(args[1]);
	return Number.isFinite(days) && days > 0 ? days : undefined;
}

function writableMetadata(session: SessionInfo) {
	return {
		sessionPath: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		parentSessionPath: session.parentSessionPath,
		createdAt: session.created.toISOString(),
		modifiedAt: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
	};
}

function formatTruncateToolOutputReport(report: ToolResultSessionMigrationReport): string {
	const skipped = report.skippedMalformedFiles + report.skippedNonSessionFiles + report.skippedErrorFiles;
	const skippedText = skipped > 0 ? ` Skipped ${skipped} file${skipped === 1 ? "" : "s"}.` : "";
	return `Truncated ${report.truncatedMessages} tool result${report.truncatedMessages === 1 ? "" : "s"} in ${report.changedFiles} session${report.changedFiles === 1 ? "" : "s"}.${skippedText}\n`;
}

function printSessionsHelp(write: (text: string) => void): void {
	write(
		`Usage:\n  pi sessions archive [--older-than <days>]\n  pi sessions compress-archived [--dry-run]\n  pi sessions truncate-tool-output\n\nCommands:\n  archive                  Archive sessions older than the cutoff (default: 5 days).\n  compress-archived       Compress existing archived .jsonl sessions as .jsonl.zst.\n  truncate-tool-output    Rewrite oversized persisted tool results under the agent directory.\n                           Changed files receive a .tool-output-backup-* copy.\n`,
	);
}
