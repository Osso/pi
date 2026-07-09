import { existsSync } from "node:fs";
import { getAgentDir } from "../config.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { createReadOnlySqliteDatabase } from "../core/sqlite.ts";

export const ARCHITECT_SESSION_ID = "architect";

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

export interface ArchitectSnapshot {
	messages: ArchitectChannelMessage[];
	sessions: ArchitectSessionSnapshot[];
}

export type ArchitectSnapshotReader = (lastChannelMessageId: number) => ArchitectSnapshot;

type SessionRow = {
	cwd: string;
	goal_json: string | null;
	id: string;
	is_subagent: number;
	name: string | null;
};

type ChannelMessageRow = {
	body: string;
	id: number;
	sender_agent_id: string | null;
	sender_session_id: string;
};

export function snapshotArchitectSessions(metadata: ArchitectSessionSnapshot[]): ArchitectSessionSnapshot[] {
	return metadata.map((session) => ({ ...session })).sort((left, right) => left.id.localeCompare(right.id));
}

export function createArchitectObservation(
	previous: ArchitectObservation | undefined,
	sessions: ArchitectSessionSnapshot[],
	messages: ArchitectChannelMessage[],
): ArchitectObservation | undefined {
	const requests = messages.filter(
		(message) =>
			message.senderAgentId === null &&
			message.senderSessionId !== ARCHITECT_SESSION_ID &&
			/^\s*architect\s*:/i.test(message.body),
	);
	if (requests.length > 0) {
		return { reason: "architect_request", requests, sessions };
	}
	if (!previous || JSON.stringify(previous.sessions) !== JSON.stringify(sessions)) {
		return { reason: "session_state_changed", requests: [], sessions };
	}
	return undefined;
}

export function readArchitectSnapshot(controlDbPath: string, lastChannelMessageId: number): ArchitectSnapshot {
	if (!existsSync(controlDbPath)) {
		return { messages: [], sessions: [] };
	}
	const db = createReadOnlySqliteDatabase(controlDbPath);
	try {
		const sessions = (
			db
				.prepare(
					`SELECT id, cwd, name, goal_json, is_subagent
				 FROM session_metadata
				 ORDER BY id ASC`,
				)
				.all() as SessionRow[]
		).map((row) => ({
			cwd: row.cwd,
			goalJson: row.goal_json ?? undefined,
			id: row.id,
			isSubagent: row.is_subagent === 1,
			name: row.name ?? undefined,
		}));
		const messages = (
			db
				.prepare(
					`SELECT id, sender_session_id, sender_agent_id, body
				 FROM shared_channel_messages
				 WHERE id > ?
				 ORDER BY id ASC
				 LIMIT 20`,
				)
				.all(lastChannelMessageId) as ChannelMessageRow[]
		).map((row) => ({
			body: row.body,
			id: row.id,
			senderAgentId: row.sender_agent_id,
			senderSessionId: row.sender_session_id,
		}));
		return { messages, sessions };
	} finally {
		db.close();
	}
}

export class ArchitectObserver {
	private readonly readSnapshot: ArchitectSnapshotReader;
	private initialized = false;
	private state: ArchitectObserverState = { lastChannelMessageId: 0 };

	constructor(
		controlDbPath = getControlDbPath(getAgentDir()),
		readSnapshot: ArchitectSnapshotReader = (lastChannelMessageId) =>
			readArchitectSnapshot(controlDbPath, lastChannelMessageId),
	) {
		this.readSnapshot = readSnapshot;
	}

	observe(): ArchitectObservation | undefined {
		const { messages, sessions } = this.readSnapshot(this.state.lastChannelMessageId);
		const lastMessageId = messages.at(-1)?.id;
		if (lastMessageId !== undefined) {
			this.state.lastChannelMessageId = lastMessageId;
		}
		const newMessages = this.initialized ? messages : [];
		this.initialized = true;
		const observation = createArchitectObservation(
			this.state.lastObservation,
			snapshotArchitectSessions(sessions),
			newMessages,
		);
		if (observation) {
			this.state.lastObservation = observation;
		}
		return observation;
	}
}
