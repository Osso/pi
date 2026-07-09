import { getAgentDir } from "../config.ts";
import {
	getControlDbPath,
	listSessionMetadata,
	listSharedChannelMessagesAfter,
	type SessionMetadata,
} from "../core/session-control-db.ts";

export interface ArchitectSessionSnapshot {
	cwd: string;
	goalJson?: string;
	id: string;
	isSubagent: boolean;
	name?: string;
}

export interface ArchitectChannelMessage {
	body: string;
	id: number;
	senderAgentId: string | null;
	senderSessionId: string;
}

export interface ArchitectObservation {
	requests: ArchitectChannelMessage[];
	reason: "architect_request" | "session_state_changed";
	sessions: ArchitectSessionSnapshot[];
}

export interface ArchitectObserverState {
	lastChannelMessageId: number;
	lastObservation?: ArchitectObservation;
}

export function snapshotArchitectSessions(metadata: SessionMetadata[]): ArchitectSessionSnapshot[] {
	return metadata
		.map(({ cwd, goalJson, id, isSubagent, name }) => ({ cwd, goalJson, id, isSubagent: isSubagent ?? false, name }))
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function createArchitectObservation(
	previous: ArchitectObservation | undefined,
	sessions: ArchitectSessionSnapshot[],
	messages: ArchitectChannelMessage[],
): ArchitectObservation | undefined {
	const requests = messages.filter((message) => message.senderAgentId === null && /\barchitect\b/i.test(message.body));
	if (requests.length > 0) {
		return { reason: "architect_request", requests, sessions };
	}
	if (!previous || JSON.stringify(previous.sessions) !== JSON.stringify(sessions)) {
		return { reason: "session_state_changed", requests: [], sessions };
	}
	return undefined;
}

export class ArchitectObserver {
	private readonly controlDbPath: string;
	private initialized = false;
	private state: ArchitectObserverState = { lastChannelMessageId: 0 };

	constructor(controlDbPath = getControlDbPath(getAgentDir())) {
		this.controlDbPath = controlDbPath;
	}

	observe(): ArchitectObservation | undefined {
		const sessions = snapshotArchitectSessions(listSessionMetadata(this.controlDbPath));
		const messages = listSharedChannelMessagesAfter(this.controlDbPath, this.state.lastChannelMessageId).map(
			(message) => ({
				body: message.body,
				id: message.id,
				senderAgentId: message.sender.agentId,
				senderSessionId: message.sender.sessionId,
			}),
		);
		const lastMessageId = messages.at(-1)?.id;
		if (lastMessageId !== undefined) {
			this.state.lastChannelMessageId = lastMessageId;
		}
		const newMessages = this.initialized ? messages : [];
		this.initialized = true;
		const observation = createArchitectObservation(this.state.lastObservation, sessions, newMessages);
		if (observation) {
			this.state.lastObservation = observation;
		}
		return observation;
	}
}
