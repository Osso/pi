import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { listSessions } from "../session-directory.ts";
import type { SessionDirectoryEntry } from "../session-health.ts";

const listSessionsSchema = Type.Object({
	include_ended: Type.Optional(
		Type.Boolean({
			description: "Include ended/sticky-dead sessions. Defaults to true so failures remain inspectable.",
		}),
	),
});

export type ListSessionsToolInput = Static<typeof listSessionsSchema>;

export interface ListSessionsToolDetails {
	sessions: SessionDirectoryEntry[];
}

function formatSessionLine(session: SessionDirectoryEntry): string {
	const name = session.name ? ` name=${session.name}` : "";
	const goal = session.goal ? ` goal=${JSON.stringify(session.goal)}` : "";
	const cwd = session.cwd ? ` cwd=${session.cwd}` : "";
	const pid = session.pid === null ? "pid=null" : `pid=${session.pid}`;
	return `${session.sessionId} status=${session.status} check=${session.checkStatus} eligible=${session.eligibleToReceive} ${pid}${name}${goal}${cwd}`;
}

export function createListSessionsToolDefinition(): ToolDefinition<typeof listSessionsSchema, ListSessionsToolDetails> {
	return {
		name: "list_sessions",
		label: "list_sessions",
		description:
			"List known Pi sessions with purpose metadata and sticky liveness checks. Use this before messaging other sessions.",
		promptSnippet: "List running/known sessions with purpose and liveness",
		promptGuidelines: [
			"Use list_sessions to discover other Pi sessions and inspect whether they are eligible to receive messages.",
			"Prefer name and goal fields to understand what a session is for; ids alone are usually not useful.",
			"Sessions marked checkStatus=dead for the current agentGeneration are sticky-dead and should be skipped until a new agent starts for that session.",
		],
		parameters: listSessionsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const controlDbPath = requireControlDbPath(ctx);
			const sessions = listSessions(controlDbPath, {
				includeEnded: params.include_ended ?? true,
				touchCurrentSessionId: ctx?.sessionManager.getSessionId(),
				touchCurrentSessionPath: ctx?.sessionManager.getSessionFile(),
			});
			const lines =
				sessions.length === 0
					? ["No sessions found."]
					: sessions.map((session, index) => `${index + 1}. ${formatSessionLine(session)}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { sessions },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("list_sessions"))}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n");
			text.setText(output ? `\n${theme.fg(result.isError ? "error" : "toolOutput", output)}` : "");
			return text;
		},
	};
}

function requireControlDbPath(ctx: ExtensionContext | undefined): string {
	if (!ctx?.controlDbPath) {
		throw new Error("list_sessions requires a control database path");
	}
	return ctx.controlDbPath;
}
