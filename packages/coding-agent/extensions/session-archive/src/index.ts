import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { archiveSession } from "../../../src/core/session-control-db.ts";

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
	pi.registerCommand("archive", {
		description: "Archive the current session",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /archive", "warning");
				return;
			}
			if (!ctx.controlDbPath) {
				ctx.ui.notify("Session archive requires a control database.", "error");
				return;
			}
			const sessionPath = ctx.sessionManager.getSessionFile();
			if (!sessionPath) {
				ctx.ui.notify("The current session is not persisted.", "warning");
				return;
			}

			archiveSession(ctx.controlDbPath, sessionPath);
			ctx.ui.notify("Archived current session.", "info");
		},
	});
}
