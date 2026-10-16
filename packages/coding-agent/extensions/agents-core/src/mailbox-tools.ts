import { Type } from "typebox";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import type { AgentFileReference } from "../../../src/core/multi-agent-store.ts";

/** Literal transport inputs, including programmatic pi.messages.send requests. */
export interface ContactParentMessageParams {
	fileRefs?: AgentFileReference[];
	message: string;
	threadId?: string;
}

export interface SendAgentMessageParams extends ContactParentMessageParams {
	toAgentId: string;
	toSessionId?: string;
	toHost?: string;
}

interface MailboxToolTransports {
	contactParent(params: ContactParentMessageParams, ctx: ExtensionContext): AgentToolResult<unknown>;
	sendAgentMessage(params: SendAgentMessageParams, ctx: ExtensionContext): AgentToolResult<unknown>;
}

const fileReferenceSchema = Type.Object({
	path: Type.String(),
	label: Type.Optional(Type.String()),
});

const mailboxParameters = {
	body: Type.String({
		minLength: 1,
		pattern: "\\S",
		description: "Required nonblank message body, sent verbatim. Independent of assistant text or reasoning.",
	}),
	fileRefs: Type.Optional(Type.Array(fileReferenceSchema, { description: "Optional file references to attach." })),
	threadId: Type.Optional(Type.String({ description: "Optional thread identifier for conversation correlation." })),
};

const contactParentSchema = Type.Object(mailboxParameters, { additionalProperties: false });
const sendAgentMessageSchema = Type.Object(
	{
		...mailboxParameters,
		toAgentId: Type.String({
			description: "Target agent ID, or 'main' when sending to another session's main thread.",
		}),
		toHost: Type.Optional(
			Type.String({
				description:
					"Target hostname for a session on another host; requires toSessionId. Omit for local delivery.",
			}),
		),
		toSessionId: Type.Optional(
			Type.String({ description: "Optional target session ID for direct cross-session mailbox delivery." }),
		),
	},
	{ additionalProperties: false },
);

const outgoingBodyGuideline =
	"For send_agent_message and contact_parent, put the complete outgoing message in the required body argument. It is sent verbatim; assistant narration and reasoning are never read. No assistant text is required, and multiple calls in one turn can send distinct bodies.";

function createSendAgentMessageTool(transports: MailboxToolTransports) {
	return defineTool({
		name: "send_agent_message",
		label: "Send Agent Message",
		description:
			"Send the required body verbatim across a direct parent-child edge, or to another session via toSessionId (with toAgentId 'main'). For another host, also pass toHost; the message queues locally until relay delivery. Unknown local sessions are rejected. Supply the complete message in body; assistant narration and reasoning are never read.",
		promptGuidelines: [
			outgoingBodyGuideline,
			"For a cross-host reply, use the sender's hostname as toHost plus its session ID as toSessionId. Never infer host ownership from a session ID.",
		],
		approvalRequired: false,
		parameters: sendAgentMessageSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
			transports.sendAgentMessage(
				{
					fileRefs: params.fileRefs,
					message: params.body,
					threadId: params.threadId,
					toAgentId: params.toAgentId,
					toSessionId: params.toSessionId,
					toHost: params.toHost,
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
			"Send the required body verbatim as a child-agent mailbox request to its direct parent. Supply the complete message in body; assistant narration and reasoning are never read.",
		promptGuidelines: [outgoingBodyGuideline],
		approvalRequired: false,
		parameters: contactParentSchema,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
			transports.contactParent(
				{
					fileRefs: params.fileRefs,
					message: params.body,
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
