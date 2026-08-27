import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { advanceSharedChannelCursor, postSharedChannelMessage } from "../session-control-db.ts";

const channelPostSchema = Type.Object({
	message: Type.String({
		description:
			"One short action-required broadcast naming the exact affected shared path or installed artifact and required action.",
	}),
});

export type ChannelPostToolInput = Static<typeof channelPostSchema>;

export interface ChannelPostToolDetails {
	messageId: number;
}

export function createChannelPostToolDefinition(): ToolDefinition<typeof channelPostSchema, ChannelPostToolDetails> {
	return {
		name: "channel_post",
		label: "channel_post",
		description:
			"Append one action-required coordination broadcast to the global shared channel. Idle sessions read new channel messages from control.sqlite using per-session cursors.",
		promptSnippet: "Post an action-required broadcast to the global shared channel",
		promptGuidelines: [
			"Post only when other sessions must take a concrete action now. Treat channel_post as a low-volume broadcast bus, not a conversation; valid cases are an already-shared checkout collision, blocker, or release, a blocking dependency, or an installed Pi runtime replacement.",
			"Include the exact affected shared path or installed artifact and required action. Keep each post to one short sentence when possible, two maximum. Omit task descriptions, planned file inventories, implementation scope, rationale, progress, and deployment narration unless required for safe action.",
			"Do not post diagnostics, tests, acknowledgements, restatements, reviews, or status updates. This includes experiments, delivery or echo/tag tests, liveness probes, architecture requests, evidence gathering, falsification checks, untouched or no-overlap reports, no-action updates, and conversational replies.",
			"Do not post isolated-worktree ownership or release; isolation already prevents conflicts. Correct a prior post only when the required action changed.",
			"Prefer send_agent_message for targeted coordination. If independent main sessions lack a direct mailbox path, use one minimal targeted channel post rather than a conversation.",
			"For urgent targeted wakeups, use broadcast with explicit filters instead.",
			"For Pi runtime replacements, identify the installed artifact and tell affected sessions to call restart_self.",
		],
		parameters: channelPostSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx?.multiAgentAgentId || ctx?.multiAgentRequiresAgentId) {
				throw new Error("channel_post is only available from main sessions");
			}
			const controlDbPath = requireControlDbPath(ctx);
			const message = params.message.trim();
			if (!message) {
				throw new Error("channel_post requires a non-empty message");
			}
			const sender = {
				agentId: ctx?.multiAgentAgentId ?? null,
				sessionId: ctx?.sessionManager.getSessionId() ?? "unknown-session",
			};
			const messageId = postSharedChannelMessage(controlDbPath, { body: message, sender });
			// The sender already knows what it wrote; skip self-echo on the next idle drain.
			advanceSharedChannelCursor(controlDbPath, sender, messageId);
			return {
				content: [{ type: "text", text: `Posted shared channel message ${messageId}.` }],
				details: { messageId },
			};
		},
		renderCall(_args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("channel_post"))}`);
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
		throw new Error("channel_post requires a control database path");
	}
	return ctx.controlDbPath;
}
