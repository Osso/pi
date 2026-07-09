import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { advanceSharedChannelCursor, postSharedChannelMessage } from "../session-control-db.ts";

const channelPostSchema = Type.Object({
	message: Type.String({ description: "Message body to append to the global shared session channel." }),
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
			"Append one message to the global shared channel. Idle sessions read new channel messages from control.sqlite using per-session cursors.",
		promptSnippet: "Post a message to the global shared channel",
		promptGuidelines: [
			"Use channel_post for soft cross-session coordination; idle sessions catch up from their cursor.",
			"Do not use channel_post for urgent targeted wakeups; use broadcast with explicit filters for that.",
		],
		parameters: channelPostSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
