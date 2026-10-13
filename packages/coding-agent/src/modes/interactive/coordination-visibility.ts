import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueuedMessagePreview } from "../../core/agent-session.ts";

const MAILBOX_ENVELOPE =
	/^From:\n(?:- host: [^\n]+ \(reply with toHost and toSessionId\)\n)?(?:- session: [^\n]+\n)?- agent: [^\n]+\n\nMessage:\n/;

export function isCoordinationPreview(message: QueuedMessagePreview): boolean {
	return (
		message.customType === "shared_channel" ||
		(message.inputSource === "extension" && MAILBOX_ENVELOPE.test(message.text))
	);
}

export function isCoordinationMessage(message: AgentMessage): boolean {
	if (message.role === "custom") return message.customType === "shared_channel";
	if (message.role !== "user" || message.inputSource !== "extension") return false;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
	return MAILBOX_ENVELOPE.test(text);
}
