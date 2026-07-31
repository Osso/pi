import { getAgentDir } from "../config.ts";
import { archiveSessionsOlderThan, getControlDbPath, writeSessionMetadata } from "../core/session-control-db.ts";
import type { SessionInfo } from "../core/session-manager.ts";
import { SessionManager } from "../core/session-manager.ts";
import { migrateToolResultSessionFiles, type ToolResultSessionMigrationReport } from "../core/session-tool-output.ts";

interface SessionsCommandDependencies {
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	now?: () => Date;
	refreshMetadata?: (controlDbPath: string) => Promise<void>;
	archiveOlderThan?: (controlDbPath: string, cutoff: Date) => string[];
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

	const controlDbPath = getControlDbPath();
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
	const archived = (dependencies.archiveOlderThan ?? archiveSessionsOlderThan)(controlDbPath, cutoff);
	stdout(
		`Archived ${archived.length} session${archived.length === 1 ? "" : "s"} older than ${days} day${days === 1 ? "" : "s"}.\n`,
	);
	return true;
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
		`Usage:\n  pi sessions archive [--older-than <days>]\n  pi sessions truncate-tool-output\n\nCommands:\n  archive                  Archive sessions older than the cutoff (default: 5 days).\n  truncate-tool-output    Rewrite oversized persisted tool results under the agent directory.\n                           Changed files receive a .tool-output-backup-* copy.\n`,
	);
}
