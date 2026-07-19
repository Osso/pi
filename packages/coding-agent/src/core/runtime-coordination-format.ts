import type { RuntimeMailboxMessage, SharedChannelMessage } from "./session-control-db.ts";

export function formatRuntimeMailboxPrompt(message: RuntimeMailboxMessage, recipientSessionId: string): string {
	const senderSession = message.sender.sessionId || "unknown-session";
	const senderAgent = message.sender.agentId || "main";
	const body = message.body.trim() || "No message body.";
	const senderLines =
		senderSession === recipientSessionId
			? [`- agent: ${senderAgent}`]
			: [`- session: ${senderSession}`, `- agent: ${senderAgent}`];
	const sections = ["From:", ...senderLines, "", "Message:", body];
	return [...sections, ...formatRuntimeMailboxFileReferences(message)].join("\n");
}

export function formatSharedChannelPrompt(messages: SharedChannelMessage[], recipientSessionId: string): string {
	return messages.map((message) => formatSharedChannelMessage(message, recipientSessionId)).join("\n\n");
}

function formatSharedChannelMessage(message: SharedChannelMessage, recipientSessionId: string): string {
	const senderSession = message.sender.sessionId || "unknown-session";
	const senderAgent = message.sender.agentId || "main";
	const body = message.body.trim() || "No message body.";
	const senderLines =
		senderSession === recipientSessionId
			? [`- agent: ${senderAgent}`]
			: [`- session: ${senderSession}`, `- agent: ${senderAgent}`];
	return ["From shared channel:", ...senderLines, "", "Message:", body].join("\n");
}

function formatRuntimeMailboxFileReferences(message: RuntimeMailboxMessage): string[] {
	const fileRefs = message.fileRefs?.map(formatRuntimeMailboxFileReference) ?? [];
	return fileRefs.length > 0 ? ["Attached files:", ...fileRefs] : [];
}

function formatRuntimeMailboxFileReference(ref: NonNullable<RuntimeMailboxMessage["fileRefs"]>[number]): string {
	const label = ref.label ? `${ref.label} — ` : "";
	return `- ${label}${ref.path}`;
}
