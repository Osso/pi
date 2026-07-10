import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { broadcastToSessions } from "../session-directory.ts";
import type { SessionBroadcastResult } from "../session-health.ts";

const broadcastSchema = Type.Object({
	message: Type.String({ description: "Message body to deliver to eligible sessions." }),
	session_ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional exact session id allowlist. When omitted, all inventory sessions are candidates.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Optional exact cwd filter." })),
	name: Type.Optional(Type.String({ description: "Optional exact session name filter." })),
	status: Type.Optional(
		Type.Array(Type.Union([Type.Literal("running"), Type.Literal("idle"), Type.Literal("ended")]), {
			description: "Optional status filter.",
		}),
	),
});

export type BroadcastToolInput = Static<typeof broadcastSchema>;

export interface BroadcastToolDetails {
	results: SessionBroadcastResult[];
	sent: number;
	skipped: number;
	failed: number;
}

function formatBroadcastResult(result: SessionBroadcastResult): string {
	const error = result.error ? ` error=${JSON.stringify(result.error)}` : "";
	return `${result.sessionId} outcome=${result.outcome} check=${result.checkStatus}${error}`;
}

export function createBroadcastToolDefinition(): ToolDefinition<typeof broadcastSchema, BroadcastToolDetails> {
	return {
		name: "broadcast",
		label: "broadcast",
		description:
			"Send one message to eligible Pi sessions after sticky health checks. Dead sessions for the current agent generation are skipped until a newer agent starts.",
		promptSnippet: "Broadcast a message to eligible sessions after liveness checks",
		promptGuidelines: [
			"Use list_sessions first when you need purpose/context for destination selection.",
			"broadcast never targets sticky-dead sessions for the current agent generation.",
			"Prefer filters (session_ids, cwd, name, status) over unfiltered broadcasts.",
		],
		parameters: broadcastSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const controlDbPath = requireControlDbPath(ctx);
			const sessionPath = ctx?.sessionManager.getSessionFile();
			if (!sessionPath) {
				throw new Error("broadcast requires a persisted session file");
			}
			const results = broadcastToSessions(controlDbPath, {
				message: params.message,
				filters: {
					sessionIds: params.session_ids,
					cwd: params.cwd,
					name: params.name,
					status: params.status,
				},
				senderSessionId: ctx.sessionManager.getSessionId(),
				senderSessionPath: sessionPath,
				senderAgentId: ctx.multiAgentAgentId ?? null,
			});
			const sent = results.filter((result) => result.outcome === "sent").length;
			const failed = results.filter(
				(result) =>
					result.outcome === "send_failed" || result.outcome === "check_failed" || result.outcome === "timeout",
			).length;
			const skipped = results.length - sent - failed;
			const lines =
				results.length === 0
					? ["No sessions matched."]
					: [
							`sent=${sent} skipped=${skipped} failed=${failed}`,
							...results.map((result, index) => `${index + 1}. ${formatBroadcastResult(result)}`),
						];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { results, sent, skipped, failed },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const filters: string[] = [];
			if (args.session_ids?.length) filters.push(`ids=${args.session_ids.length}`);
			if (args.cwd) filters.push(`cwd=${args.cwd}`);
			if (args.name) filters.push(`name=${args.name}`);
			if (args.status?.length) filters.push(`status=${args.status.join(",")}`);
			const filterText = filters.length > 0 ? ` ${theme.fg("dim", filters.join(" "))}` : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("broadcast"))}${filterText}`);
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
		throw new Error("broadcast requires a control database path");
	}
	return ctx.controlDbPath;
}
