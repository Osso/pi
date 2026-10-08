/** Argument keys that best describe what a tool call is doing, in priority order. */
const DETAIL_ARGUMENT_KEYS = [
	"command",
	"code",
	"path",
	"file_path",
	"pattern",
	"query",
	"url",
	"prompt",
	"message",
	"agentId",
] as const;

export const MAX_ACTIVITY_DETAIL_LENGTH = 160;

/** One-line summary of a tool call's arguments for agent activity displays. */
export function summarizeToolArguments(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of DETAIL_ARGUMENT_KEYS) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const singleLine = value.replace(/\s+/g, " ").trim();
		if (!singleLine) continue;
		return singleLine.length > MAX_ACTIVITY_DETAIL_LENGTH
			? `${singleLine.slice(0, MAX_ACTIVITY_DETAIL_LENGTH - 1)}…`
			: singleLine;
	}
	return undefined;
}
