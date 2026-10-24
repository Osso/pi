//! Session naming tool for main sessions.
//!
//! The model names the session itself through the `set_session_name` tool instead of
//! an extension-issued title request, so naming costs no extra provider call.

import { type Static, Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

const MAX_NAME_CHARS = 80;

const SET_SESSION_NAME_PARAMETERS = Type.Object({
	name: Type.String({ description: "Short 2-4 word session title." }),
});

type SetSessionNameParams = Static<typeof SET_SESSION_NAME_PARAMETERS>;

interface SetSessionNameDetails {
	name: string;
}

export default function sessionAutonameExtension(pi: ExtensionAPI): void {
	let nameSetByTool: string | undefined;

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
			const refusal = describeRefusal(ctx, name, nameSetByTool);
			if (refusal) return errorResult(refusal);
			pi.setSessionName(name);
			nameSetByTool = name;
			return { content: [{ type: "text", text: `Session name set to "${name}".` }], details: { name } };
		},
	});
}

/** Return why the session cannot take this name, or undefined when it can. */
function describeRefusal(
	ctx: ExtensionContext,
	name: string,
	nameSetByTool: string | undefined,
): string | undefined {
	if (!name) return "Session name must be a non-empty string.";
	if (ctx.multiAgentAgentId || ctx.sessionManager.isSubagentSession()) {
		return "Child agent sessions cannot be named.";
	}
	if (!ctx.sessionManager.getSessionFile()) {
		return "Only persisted sessions can be named.";
	}
	const currentName = ctx.sessionManager.getSessionName();
	if (currentName === undefined && ctx.sessionManager.hasSessionNameState()) {
		return "The session name was cleared explicitly; leave it unnamed.";
	}
	if (currentName !== undefined && currentName !== nameSetByTool) {
		return `The session is already named "${currentName}".`;
	}
	return undefined;
}

function normalizeName(rawName: string): string {
	const collapsed = rawName.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	if (collapsed.length <= MAX_NAME_CHARS) return collapsed;
	const bounded = collapsed.slice(0, MAX_NAME_CHARS + 1);
	const lastSpace = bounded.lastIndexOf(" ");
	return (lastSpace > 0 ? bounded.slice(0, lastSpace) : bounded.slice(0, MAX_NAME_CHARS)).trim();
}

function errorResult(message: string): AgentToolResult<SetSessionNameDetails> {
	return { content: [{ type: "text", text: message }], details: { name: "" }, isError: true };
}
