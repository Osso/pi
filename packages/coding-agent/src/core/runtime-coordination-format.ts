import type { RuntimeMailboxMessage, SharedChannelMessage } from "./session-control-db.ts";

const SHARED_CHANNEL_RECEIVE_GUIDANCE = [
	"Shared-channel handling:",
	"Treat these messages as action-only coordination, not conversation.",
	"Do not acknowledge, restate, relay, summarize, or review channel messages.",
	"Do not confirm, praise, or classify them through channel_post.",
	"Take no action unless the message requests action from you or its affected path or artifact overlaps your work.",
	"Never echo diagnostic or test messages onto the shared channel. The same prohibition covers experiments, probes, and tag tests.",
	"Correct misuse only when needed to stop an immediate or repeated coordination hazard, using one terse targeted command.",
].join("\n");

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
	const formattedMessages = messages
		.map((message) => formatSharedChannelMessage(message, recipientSessionId))
		.join("\n\n");
	return [formattedMessages, SHARED_CHANNEL_RECEIVE_GUIDANCE].join("\n\n");
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
