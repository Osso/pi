import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { archivePersistedSession } from "../../../src/core/session-archive-storage.ts";
import { readSessionMetadata, unarchiveSession } from "../../../src/core/session-control-db.ts";

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
	pi.registerCommand("unarchive", {
		description: "Unarchive the current session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /unarchive", "warning");
				return;
			}
			const controlDbPath = ctx.controlDbPath;
			if (!controlDbPath) {
				ctx.ui.notify("Session unarchive requires a control database.", "error");
				return;
			}
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify("The current session is not persisted.", "warning");
				return;
			}
			if (!readSessionMetadata(controlDbPath, sessionPath)?.isArchived) {
				ctx.ui.notify("Current session is already unarchived.", "info");
				return;
			}
			unarchiveSession(controlDbPath, sessionPath);
			ctx.ui.notify("Unarchived current session.", "info");
		},
	});

	pi.registerCommand("archive", {
		description: "Archive the current session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /archive", "warning");
				return;
			}
			const controlDbPath = ctx.controlDbPath;
			if (!controlDbPath) {
				ctx.ui.notify("Session archive requires a control database.", "error");
				return;
			}
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify("The current session is not persisted.", "warning");
				return;
			}

			await ctx.newSession({
				withSession: async (nextCtx) => {
					archivePersistedSession(controlDbPath, sessionPath);
					nextCtx.ui.notify("Archived current session.", "info");
				},
			});
		},
	});
}
