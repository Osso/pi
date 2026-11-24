//! Session naming tool for main sessions.
//!
//! The model names the session itself through the `set_session_name` tool instead of
//! an extension-issued title request, so naming costs no extra provider call.

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

const MAX_NAME_CHARS = 80;

const SET_SESSION_NAME_PARAMETERS = Type.Object({
	name: Type.String({ description: "Short 2-4 word session title." }),
});

interface SetSessionNameDetails {
	name: string;
	/** Persisted name revision of a successful write; the transcript keeps it across reload and restart. */
	revision?: number;
}

export default function sessionAutonameExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof SET_SESSION_NAME_PARAMETERS, SetSessionNameDetails>({
		name: "set_session_name",
		label: "Set Session Name",
		description:
			"Set a short display name for an eligible persisted main session. Skip named, explicitly cleared, ephemeral, and child sessions. If naming is refused, continue the user's task; naming is not a prerequisite for task work.",
		promptGuidelines: [
			"Call set_session_name once, early, with a concise 2-4 word title describing the user's request only in an eligible persisted main session. Skip named, explicitly cleared, ephemeral, and child sessions.",
			"If set_session_name refuses the request, continue the user's task. Do not stop or end the turn because naming failed; naming is not a prerequisite for task work.",
		],
		approvalRequired: false,
		parameters: SET_SESSION_NAME_PARAMETERS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = normalizeName(params.name);
			const refusal = describeIneligibleSession(ctx, name);
			if (refusal) return errorResult(refusal);

			const result = pi.setSessionName(name, findLastWriteRevision(ctx));
			if (!result.written || result.revision === null) return errorResult(describeWriteRefusal(result));
			return {
				content: [{ type: "text", text: `Session name set to "${name}".` }],
				details: { name, revision: result.revision },
			};
		},
	});
}

/** Revision of this tool's latest successful write in the session, or null when it never named the session. */
function findLastWriteRevision(ctx: ExtensionContext): number | null {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "set_session_name" || message.isError) continue;
		const revision = (message.details as SetSessionNameDetails | undefined)?.revision;
		return typeof revision === "number" ? revision : null;
	}
	return null;
}

/** Return why the session cannot take this name, or undefined when it can. */
function describeIneligibleSession(ctx: ExtensionContext, name: string): string | undefined {
	if (!name) return "Session name must be a non-empty string.";
	if (ctx.multiAgentAgentId || ctx.sessionManager.isSubagentSession()) {
		return "Child agent sessions cannot be named.";
	}
	if (!ctx.sessionManager.getSessionFile()) {
		return "Only persisted sessions can be named.";
	}
	return undefined;
}

function describeWriteRefusal(state: { name: string | undefined; hasStoredValue: boolean }): string {
	if (state.name !== undefined) return `The session is already named "${state.name}".`;
	if (state.hasStoredValue) return "The session name was cleared explicitly; leave it unnamed.";
	return "The stored session name changed or is not available.";
}

function normalizeName(rawName: string): string {
	const collapsed = rawName
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// Count code points, not UTF-16 units, so the bound never splits an emoji.
	const chars = Array.from(collapsed);
	if (chars.length <= MAX_NAME_CHARS) return collapsed;
	const bounded = chars.slice(0, MAX_NAME_CHARS + 1).join("");
	const lastSpace = bounded.lastIndexOf(" ");
	return (lastSpace > 0 ? bounded.slice(0, lastSpace) : chars.slice(0, MAX_NAME_CHARS).join("")).trim();
}

function errorResult(message: string): AgentToolResult<SetSessionNameDetails> {
	return { content: [{ type: "text", text: message }], details: { name: "" }, isError: true };
}
