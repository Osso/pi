import { Type } from "typebox";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import type { AgentFileReference } from "../../../src/core/multi-agent-store.ts";
import { readCurrentToolCallText } from "./current-tool-text.ts";

/** Literal transport inputs, including programmatic pi.messages.send requests. */
export interface ContactParentMessageParams {
	fileRefs?: AgentFileReference[];
	message: string;
	threadId?: string;
}

export interface SendAgentMessageParams extends ContactParentMessageParams {
	toAgentId: string;
	toSessionId?: string;
}

interface MailboxToolTransports {
	contactParent(params: ContactParentMessageParams, ctx: ExtensionContext): AgentToolResult<unknown>;
	sendAgentMessage(params: SendAgentMessageParams, ctx: ExtensionContext): AgentToolResult<unknown>;
}

const fileReferenceSchema = Type.Object({
	path: Type.String(),
	label: Type.Optional(Type.String()),
});

const mailboxMetadata = {
	fileRefs: Type.Optional(Type.Array(fileReferenceSchema, { description: "Optional file references to attach." })),
	textIndex: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"Zero-based index among text blocks in the assistant message containing this tool call, not among all content blocks. Required when that message has multiple text blocks; omit for one text block.",
		}),
	),
	threadId: Type.Optional(Type.String({ description: "Optional thread identifier for conversation correlation." })),
};

const contactParentSchema = Type.Object(mailboxMetadata, { additionalProperties: false });
const sendAgentMessageSchema = Type.Object(
	{
		...mailboxMetadata,
		toAgentId: Type.String({
			description: "Target agent ID, or 'main' when sending to another session's main thread.",
		}),
		toSessionId: Type.Optional(
			Type.String({ description: "Optional target session ID for direct cross-session mailbox delivery." }),
		),
	},
	{ additionalProperties: false },
);

const outgoingTextGuideline =
	"For send_agent_message and contact_parent, write the outgoing body as assistant text in the same message as the mailbox tool call, then call that tool with routing/fileRefs/thread metadata only. The selected assistant text is sent verbatim. With multiple text blocks, set textIndex to the zero-based index among text blocks, not all content blocks; omit it when there is exactly one text block.";

function createSendAgentMessageTool(transports: MailboxToolTransports) {
	return defineTool({
		name: "send_agent_message",
		label: "Send Agent Message",
		description:
			"Send assistant text verbatim to a local child or sibling agent, or another session via toSessionId (with toAgentId 'main'). Write the outgoing body as assistant text alongside this tool call, then pass only metadata; use textIndex when there are multiple text blocks.",
		promptGuidelines: [outgoingTextGuideline],
		approvalRequired: false,
		parameters: sendAgentMessageSchema,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
			transports.sendAgentMessage(
				{
					fileRefs: params.fileRefs,
					message: readCurrentToolCallText(ctx, toolCallId, "send_agent_message", params.textIndex),
					threadId: params.threadId,
					toAgentId: params.toAgentId,
					toSessionId: params.toSessionId,
				},
				ctx,
			),
	});
}

function createContactParentTool(transports: MailboxToolTransports) {
	return defineTool({
		name: "contact_parent",
		label: "Contact Parent",
		description:
			"Send assistant text verbatim as a child-agent mailbox request to its direct parent. Write the outgoing body as assistant text alongside this tool call, then pass only metadata; use textIndex when there are multiple text blocks.",
		promptGuidelines: [outgoingTextGuideline],
		approvalRequired: false,
		parameters: contactParentSchema,
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
			transports.contactParent(
				{
					fileRefs: params.fileRefs,
					message: readCurrentToolCallText(ctx, toolCallId, "contact_parent", params.textIndex),
					threadId: params.threadId,
				},
				ctx,
			),
	});
}

export function registerModelMailboxTools(pi: ExtensionAPI, transports: MailboxToolTransports): void {
	pi.registerTool(createSendAgentMessageTool(transports));
	pi.registerTool(createContactParentTool(transports));
}
