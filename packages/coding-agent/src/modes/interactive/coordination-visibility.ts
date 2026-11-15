import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueuedMessagePreview } from "../../core/agent-session.ts";

const MAILBOX_ENVELOPE =
	/^From:\n(?:- host: [^\n]+ \(reply with toHost and toSessionId\)\n)?(?:- session: [^\n]+\n)?- agent: [^\n]+\n\nMessage:\n/;

const PERIODIC_AUDIT_TAG = /^\[periodic-checks: [^\n]+\]$/;

/** Shows a single delivered periodic-checks audit report as its leading `[periodic-checks: …]` tag line only. */
export function compactCoordinationText(text: string, coordination: boolean): string {
	if (!coordination || text.match(/^From:$/gm)?.length !== 1) return text;
	const [tag] = text.replace(MAILBOX_ENVELOPE, "").split("\n", 1);
	return tag !== undefined && PERIODIC_AUDIT_TAG.test(tag) ? tag : text;
}

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
