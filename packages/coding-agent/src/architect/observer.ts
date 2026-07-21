import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	type ArchitectRequest,
	claimPendingArchitectRequests,
	completeArchitectRequest,
	getControlDbPath,
	renewArchitectRequestClaims,
} from "../core/session-control-db.ts";
import { configureReadOnlySqliteDatabase, createReadOnlySqliteDatabase } from "../core/sqlite.ts";

export const ARCHITECT_SESSION_ID = "architect";

export interface ArchitectSessionSnapshot {
	cwd: string;
	goalJson?: string;
	id: string;
	isSubagent: boolean;
	name?: string;
}

export type ArchitectChannelMessage = ArchitectRequest;

export interface ArchitectObservation {
	requests: ArchitectRequest[];
	reason: "architect_request" | "session_state_changed";
	sessions: ArchitectSessionSnapshot[];
}

export interface ArchitectObserverState {
	lastObservation?: ArchitectObservation;
}

export interface ArchitectSnapshot {
	requests: ArchitectRequest[];
	sessions: ArchitectSessionSnapshot[];
}

export type ArchitectSnapshotReader = () => ArchitectSnapshot;

type SessionRow = {
	cwd: string;
	goal_json: string | null;
	id: string;
	is_subagent: number;
	name: string | null;
};

export function snapshotArchitectSessions(metadata: ArchitectSessionSnapshot[]): ArchitectSessionSnapshot[] {
	return metadata.map((session) => ({ ...session })).sort((left, right) => left.id.localeCompare(right.id));
}

export function createArchitectObservation(
	previous: ArchitectObservation | undefined,
	sessions: ArchitectSessionSnapshot[],
	requests: ArchitectRequest[],
): ArchitectObservation | undefined {
	if (requests.length > 0) {
		return { reason: "architect_request", requests, sessions };
	}
	if (!previous || JSON.stringify(previous.sessions) !== JSON.stringify(sessions)) {
		return { reason: "session_state_changed", requests: [], sessions };
	}
	return undefined;
}

export function readArchitectSnapshot(controlDbPath: string): ArchitectSnapshot {
	if (!existsSync(controlDbPath)) {
		return { requests: [], sessions: [] };
	}
	const db = createReadOnlySqliteDatabase(controlDbPath);
	configureReadOnlySqliteDatabase(db);
	try {
		const sessions = (
			db
				.prepare(
					`WITH current_sessions AS (
						SELECT
							metadata.id,
							metadata.cwd,
							metadata.name,
							metadata.goal_json,
							metadata.is_subagent,
							ROW_NUMBER() OVER (
								PARTITION BY listener.pid
								ORDER BY listener.updated_at DESC, metadata.modified_at DESC,
									metadata.updated_at DESC, metadata.session_path DESC
							) AS row_number
						FROM session_metadata AS metadata
						INNER JOIN runtime_mailbox_listeners AS listener
							ON listener.recipient_session_id = metadata.id
							AND listener.recipient_agent_id_key = ''
						INNER JOIN session_health AS health
							ON health.session_id = metadata.id
							AND health.pid = listener.pid
						WHERE health.pid IS NOT NULL
							AND health.check_status = 'ok'
							AND health.checked_generation = health.agent_generation
							AND julianday(health.last_active_at) >= julianday('now', '-5 minutes')
							AND metadata.is_subagent = 0
							AND metadata.id <> ?
					)
					SELECT id, cwd, name, goal_json, is_subagent
					FROM current_sessions
					WHERE row_number = 1
					ORDER BY id ASC
					LIMIT 20`,
				)
				.all(ARCHITECT_SESSION_ID) as SessionRow[]
		).map((row) => ({
			cwd: row.cwd,
			goalJson: row.goal_json ?? undefined,
			id: row.id,
			isSubagent: row.is_subagent === 1,
			name: row.name ?? undefined,
		}));
		return { requests: [], sessions };
	} finally {
		db.close();
	}
}

function readAndClaimArchitectSnapshot(controlDbPath: string, claimToken: string): ArchitectSnapshot {
	const snapshot = readArchitectSnapshot(controlDbPath);
	return { ...snapshot, requests: claimPendingArchitectRequests(controlDbPath, claimToken) };
}

export class ArchitectObserver {
	private readonly claimToken: string = randomUUID();
	private readonly controlDbPath: string;
	private readonly readSnapshot: ArchitectSnapshotReader;
	private state: ArchitectObserverState = {};

	constructor(controlDbPath = getControlDbPath(), readSnapshot?: ArchitectSnapshotReader) {
		this.controlDbPath = controlDbPath;
		this.readSnapshot = readSnapshot ?? (() => readAndClaimArchitectSnapshot(controlDbPath, this.claimToken));
	}

	observe(): ArchitectObservation | undefined {
		const snapshot = this.readSnapshot();
		const observation = createArchitectObservation(
			this.state.lastObservation,
			snapshotArchitectSessions(snapshot.sessions),
			snapshot.requests,
		);
		if (observation) {
			this.state.lastObservation = observation;
		}
		return observation;
	}

	renewRequests(requestIds: number[]): void {
		renewArchitectRequestClaims(this.controlDbPath, requestIds, this.claimToken);
	}

	completeRequest(requestId: number, senderSessionId: string): void {
		completeArchitectRequest(this.controlDbPath, requestId, this.claimToken, senderSessionId);
	}
}
