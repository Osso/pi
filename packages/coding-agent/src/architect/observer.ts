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
					`WITH live_sessions AS (
						SELECT
							metadata.id,
							metadata.cwd,
							metadata.name,
							metadata.goal_json,
							metadata.is_subagent,
							ROW_NUMBER() OVER (
								PARTITION BY metadata.id
								ORDER BY metadata.modified_at DESC, metadata.updated_at DESC
							) AS row_number
						FROM session_metadata AS metadata
						INNER JOIN session_health AS health ON health.session_id = metadata.id
						WHERE health.pid IS NOT NULL
							AND health.check_status = 'ok'
							AND health.checked_generation = health.agent_generation
							AND julianday(health.last_active_at) >= julianday('now', '-5 minutes')
					)
					SELECT id, cwd, name, goal_json, is_subagent
					FROM live_sessions
					WHERE row_number = 1
					ORDER BY id ASC
					LIMIT 20`,
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
