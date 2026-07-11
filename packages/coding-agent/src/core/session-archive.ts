import {
	archiveSession,
	listRuntimeMailboxListeners,
	listSessionMetadata,
	writeSessionMetadata,
} from "./session-control-db.ts";
import type { SessionEntry, SessionInfo, SessionManager } from "./session-manager.ts";
import { SessionManager as SessionManagerClass } from "./session-manager.ts";

export const DEFAULT_SESSION_ARCHIVE_DAYS = 5;
export const SESSION_ARCHIVE_MESSAGE_LIMIT = 10;

export interface SessionArchiveMessage {
	role: string;
	content?: unknown;
}

export interface SessionArchiveResult {
	cutoff: Date;
	considered: number;
	archived: number;
	skippedLive: number;
	skippedIncomplete: number;
}

export function isSessionComplete(messages: readonly SessionArchiveMessage[]): boolean {
	const lastMessage = messages.at(-1);
	if (!lastMessage || lastMessage.role !== "assistant") return false;

	const text = messageText(lastMessage.content).trim();
	if (!text) return false;

	const lowerText = text.toLowerCase();
	return !/(^|\b)(checking|running|investigating|reviewing|working on|starting|trying|waiting|pending|blocked|not yet|in progress|continue|need to|let me|i['’]ll|i will|what would you like|how can i help|want me to|should i|would you like)(\b|$)|\?\s*$/.test(
		lowerText,
	);
}

export async function archiveCompletedRecentSessions(
	controlDbPath: string,
	options: {
		days?: number;
		now?: Date;
		listSessions?: () => Promise<SessionInfo[]>;
		openSession?: (sessionPath: string) => SessionManager;
	} = {},
): Promise<SessionArchiveResult> {
	const days = options.days ?? DEFAULT_SESSION_ARCHIVE_DAYS;
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	const listSessions = options.listSessions ?? (() => SessionManagerClass.listAll());
	const openSession = options.openSession ?? ((sessionPath: string) => SessionManagerClass.open(sessionPath));
	const sessions = await listSessions();
	const metadata = listSessionMetadata(controlDbPath);
	const metadataByPath = new Map(metadata.map((session) => [session.sessionPath, session]));
	const livePaths = new Set(
		listRuntimeMailboxListeners(controlDbPath)
			.map((listener) => listener.sessionPath)
			.filter((sessionPath): sessionPath is string => !!sessionPath),
	);

	for (const session of sessions) {
		writeSessionMetadata(controlDbPath, {
			sessionPath: session.path,
			id: session.id,
			cwd: session.cwd,
			name: session.name,
			parentSessionPath: session.parentSessionPath,
			createdAt: session.created.toISOString(),
			modifiedAt: session.modified.toISOString(),
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
			allMessagesText: session.allMessagesText,
		});
	}

	let considered = 0;
	let archived = 0;
	let skippedLive = 0;
	let skippedIncomplete = 0;
	for (const session of sessions) {
		if (session.modified < cutoff) continue;
		const sessionMetadata = metadataByPath.get(session.path);
		if (sessionMetadata?.isSubagent || sessionMetadata?.isArchived) continue;
		considered++;
		if (livePaths.has(session.path)) {
			skippedLive++;
			continue;
		}

		let messages: SessionArchiveMessage[];
		try {
			messages = openSession(session.path)
				.getEntries()
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.slice(-SESSION_ARCHIVE_MESSAGE_LIMIT)
				.map((entry) => {
					const message = entry.message as { role?: unknown; content?: unknown };
					return { role: String(message.role), content: message.content };
				});
		} catch {
			skippedIncomplete++;
			continue;
		}
		if (!isSessionComplete(messages)) {
			skippedIncomplete++;
			continue;
		}
		archiveSession(controlDbPath, session.path);
		archived++;
	}

	return { cutoff, considered, archived, skippedLive, skippedIncomplete };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(messageText).join(" ");
	if (content && typeof content === "object" && "text" in content) {
		return messageText((content as { text?: unknown }).text);
	}
	return "";
}
