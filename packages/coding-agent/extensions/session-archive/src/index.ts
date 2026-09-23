import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { archivePersistedSession } from "../../../src/core/session-archive-storage.ts";
import { readSessionMetadata, unarchiveSession } from "../../../src/core/session-control-db.ts";
import { deleteSessionTree } from "../../../src/core/session-delete.ts";

function validateCurrentSessionCommandAndNotify(
	command: "archive" | "delete" | "unarchive",
	args: string,
	ctx: ExtensionCommandContext,
): CurrentSession | undefined {
	if (args.trim()) {
		ctx.ui.notify(`Usage: /${command}`, "warning");
		return;
	}
	const controlDbPath = ctx.controlDbPath;
	if (!controlDbPath) {
		ctx.ui.notify(`Session ${command} requires a control database.`, "error");
		return;
	}
	const sessionPath = ctx.sessionManager.getSessionFile();
	if (!sessionPath) {
		ctx.ui.notify("The current session is not persisted.", "warning");
		return;
	}
	return { controlDbPath, sessionPath };
}

async function unarchiveCurrentSession(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const session = validateCurrentSessionCommandAndNotify("unarchive", args, ctx);
	if (!session) return;
	const { controlDbPath, sessionPath } = session;
	if (!readSessionMetadata(controlDbPath, sessionPath)?.isArchived) {
		ctx.ui.notify("Current session is already unarchived.", "info");
		return;
	}
	unarchiveSession(controlDbPath, sessionPath);
	ctx.ui.notify("Unarchived current session.", "info");
}

type CurrentSession = { controlDbPath: string; sessionPath: string };

function archiveAtQuit(session: CurrentSession): void {
	try {
		archivePersistedSession(session.controlDbPath, session.sessionPath);
	} catch (error) {
		throw new Error(`Failed to archive session: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function deleteAtQuit(session: CurrentSession): void {
	const result = deleteSessionTree(session.sessionPath, session.controlDbPath);
	if (!result.ok) throw new Error(`Failed to delete session: ${result.error}`);
}

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
	// Archive/delete run at quit teardown, after the last session write and before the resume hint is printed.
	let pendingQuitAction: (() => void) | undefined;
	const quitWith = (action: (session: CurrentSession) => void, session: CurrentSession, ctx: ExtensionCommandContext) => {
		pendingQuitAction = () => action(session);
		ctx.shutdown();
	};
	pi.on("session_shutdown", (event) => {
		const action = pendingQuitAction;
		pendingQuitAction = undefined;
		if (event.reason !== "quit" || !action) return;
		try {
			action();
		} catch (error) {
			// The TUI is already stopped at quit, so report on stderr where it stays visible after exit.
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
	});
	pi.registerCommand("unarchive", {
		description: "Unarchive the current session",
		handler: unarchiveCurrentSession,
	});
	pi.registerCommand("archive", {
		description: "Archive the current session and quit",
		handler: async (args, ctx) => {
			const session = validateCurrentSessionCommandAndNotify("archive", args, ctx);
			if (session) quitWith(archiveAtQuit, session, ctx);
		},
	});
	pi.registerCommand("delete", {
		description: "Delete the current session and its child agent sessions, then quit",
		handler: async (args, ctx) => {
			const session = validateCurrentSessionCommandAndNotify("delete", args, ctx);
			if (!session) return;
			const confirmed = await ctx.ui.confirm(
				"Delete session?",
				"Delete the current session and its child agent sessions, then quit.",
			);
			if (confirmed) quitWith(deleteAtQuit, session, ctx);
		},
	});
}
