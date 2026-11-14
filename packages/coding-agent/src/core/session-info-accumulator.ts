import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionMetadata } from "./session-control-db.ts";
import type { SessionEntry, SessionHeader, SessionInfo, SessionMessageEntry } from "./session-manager.ts";

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

export interface SessionInfoAccumulator {
	messageCount: number;
	firstMessage: string;
	lastActivityTime?: number;
}

export function createSessionInfoAccumulator(metadata?: SessionMetadata): SessionInfoAccumulator {
	return {
		messageCount: metadata?.messageCount ?? 0,
		firstMessage: metadata?.firstMessage === "(no messages)" ? "" : (metadata?.firstMessage ?? ""),
		lastActivityTime: metadata ? new Date(metadata.modifiedAt).getTime() : undefined,
	};
}

export function applySessionInfoEntry(accumulator: SessionInfoAccumulator, entry: SessionEntry): void {
	if (entry.type !== "message") return;
	accumulator.messageCount++;

	const activityTime = getMessageActivityTime(entry);
	if (typeof activityTime === "number") {
		accumulator.lastActivityTime = Math.max(accumulator.lastActivityTime ?? 0, activityTime);
	}

	if (accumulator.firstMessage) return;
	const message = entry.message;
	if (!isMessageWithContent(message)) return;
	if (message.role !== "user" || message.inputSource === "extension") return;
	accumulator.firstMessage = extractTextContent(message);
}

export function finishSessionInfo(
	filePath: string,
	header: SessionHeader,
	accumulator: SessionInfoAccumulator,
	fallbackModified: Date,
): SessionInfo {
	const cwd = typeof header.cwd === "string" ? header.cwd : "";
	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	const modified =
		typeof accumulator.lastActivityTime === "number" && accumulator.lastActivityTime > 0
			? new Date(accumulator.lastActivityTime)
			: !Number.isNaN(headerTime)
				? new Date(headerTime)
				: fallbackModified;

	return {
		path: filePath,
		id: header.id,
		cwd,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount: accumulator.messageCount,
		firstMessage: accumulator.firstMessage || "(no messages)",
	};
}
