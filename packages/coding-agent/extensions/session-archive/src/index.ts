import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { archivePersistedSession } from "../../../src/core/session-archive-storage.ts";
import { readSessionMetadata, unarchiveSession } from "../../../src/core/session-control-db.ts";

function validateCurrentSessionCommandAndNotify(
	command: "archive" | "unarchive",
	args: string,
	ctx: ExtensionCommandContext,
): { controlDbPath: string; sessionPath: string } | undefined {
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

async function archiveCurrentSession(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const session = validateCurrentSessionCommandAndNotify("archive", args, ctx);
	if (!session) return;
	const { controlDbPath, sessionPath } = session;
	await ctx.newSession({
		withSession: async (nextCtx) => {
			archivePersistedSession(controlDbPath, sessionPath);
			nextCtx.ui.notify("Archived current session.", "info");
		},
	});
}

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
	pi.registerCommand("unarchive", {
		description: "Unarchive the current session",
		handler: unarchiveCurrentSession,
	});
	pi.registerCommand("archive", {
		description: "Archive the current session",
		handler: archiveCurrentSession,
	});
}
