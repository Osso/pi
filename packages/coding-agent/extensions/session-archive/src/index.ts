import type { ExtensionAPI, ExtensionCommandContext } from "../../../src/core/extensions/types.ts";
import { archiveCompletedRecentSessions, DEFAULT_SESSION_ARCHIVE_DAYS } from "../../../src/core/session-archive.ts";

export default function sessionArchiveExtension(pi: ExtensionAPI): void {
	pi.registerCommand("archive", {
		description: "Archive completed sessions from the last five days (/archive [days])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const days = parseDays(args);
			if (days === undefined) {
				ctx.ui.notify("Usage: /archive [days]", "warning");
				return;
			}
			if (!ctx.controlDbPath) {
				ctx.ui.notify("Session archive requires a control database.", "error");
				return;
			}

			const result = await archiveCompletedRecentSessions(ctx.controlDbPath, { days });
			ctx.ui.notify(
				`Archived ${result.archived} completed session${result.archived === 1 ? "" : "s"}; skipped ${result.skippedIncomplete} incomplete and ${result.skippedLive} live.`,
				"info",
			);
		},
	});
}

function parseDays(args: string): number | undefined {
	const trimmed = args.trim();
	if (!trimmed) return DEFAULT_SESSION_ARCHIVE_DAYS;
	if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
	const days = Number(trimmed);
	return Number.isFinite(days) && days > 0 ? days : undefined;
}
