export const CONTROL_DB_SCHEMA_SQL = `
		CREATE TABLE IF NOT EXISTS incoming_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			completed_at TEXT,
			error TEXT
		);

		CREATE TABLE IF NOT EXISTS codex_restriction_recovery_claims (
			user_request_id TEXT PRIMARY KEY NOT NULL,
			claimed_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS last_message (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS runtime_mailbox_listeners (
			recipient_session_id TEXT NOT NULL,
			recipient_agent_id_key TEXT NOT NULL,
			pid INTEGER NOT NULL,
			runtime_instance_id TEXT,
			session_path TEXT,
			session_path_asserted_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (recipient_session_id, recipient_agent_id_key)
		);

		-- Reminders moved to the llm-tasks tracker (tasks with a due time).
		DROP TABLE IF EXISTS reminders;

		CREATE TABLE IF NOT EXISTS prompt_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS prompt_history_id_idx
		ON prompt_history(id DESC);

		CREATE TABLE IF NOT EXISTS session_metadata (
			session_path TEXT PRIMARY KEY,
			id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			name TEXT,
			parent_session_path TEXT,
			archived_at TEXT,
			goal_json TEXT,
			is_subagent INTEGER NOT NULL DEFAULT 0,
			subagent_name TEXT,
			model_provider TEXT,
			model_id TEXT,
			thinking_level TEXT,
			created_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			message_count INTEGER NOT NULL,
			first_message TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS session_metadata_modified_at_idx
		ON session_metadata(modified_at DESC, updated_at DESC);

		CREATE TABLE IF NOT EXISTS session_metadata_indexed_roots (
			root TEXT PRIMARY KEY,
			indexed_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS session_metadata_id_idx
		ON session_metadata(id);

		CREATE INDEX IF NOT EXISTS session_metadata_name_idx
		ON session_metadata(name);

		CREATE TABLE IF NOT EXISTS session_sandbox_profiles (
			session_path TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			profile TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS multi_agent_agents (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			data TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, agent_id)
		);

		CREATE INDEX IF NOT EXISTS multi_agent_agents_agent_updated_at_idx
		ON multi_agent_agents(CASE WHEN json_valid(data) THEN json_extract(data, '$.updatedAt') END);

		CREATE INDEX IF NOT EXISTS multi_agent_agents_detached_lifecycle_idx
		ON multi_agent_agents(
			json_extract(data, '$.detached'),
			json_extract(data, '$.lifecycle')
		)
		WHERE json_valid(data);

		CREATE TABLE IF NOT EXISTS multi_agent_runtime_owners (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			process_identity TEXT,
			owner_session_id TEXT,
			owner_agent_id TEXT,
			PRIMARY KEY (session_path, agent_id)
		);

		CREATE TABLE IF NOT EXISTS multi_agent_terminal_outbox (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			terminal_revision INTEGER NOT NULL,
			event_kind TEXT NOT NULL,
			status TEXT NOT NULL,
			claim_id TEXT,
			claimed_at TEXT,
			-- Unused since delivery deletes rows; dropping it needs a quiescent schema migration.
			delivered_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, agent_id, terminal_revision, event_kind)
		);

		CREATE INDEX IF NOT EXISTS multi_agent_terminal_outbox_status_idx
		ON multi_agent_terminal_outbox(status, updated_at);

		CREATE TABLE IF NOT EXISTS multi_agent_mailbox_messages (
			session_path TEXT NOT NULL,
			message_id TEXT NOT NULL,
			data TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, message_id)
		);

		CREATE INDEX IF NOT EXISTS multi_agent_mailbox_recipient_status_idx
		ON multi_agent_mailbox_messages(
			CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientSessionId') END,
			CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientAgentId') END,
			CASE WHEN json_valid(data) THEN json_extract(data, '$.status') END
		);

		CREATE TABLE IF NOT EXISTS multi_agent_counters_v2 (
			session_path TEXT PRIMARY KEY,
			next_agent_number INTEGER NOT NULL,
			next_message_number INTEGER NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS session_health (
			session_id TEXT PRIMARY KEY,
			agent_generation INTEGER NOT NULL,
			pid INTEGER,
			last_active_at TEXT,
			last_checked_at TEXT,
			check_status TEXT NOT NULL,
			checked_generation INTEGER,
			check_latency_ms INTEGER,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS architect_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_session_id TEXT NOT NULL,
			project_cwd TEXT,
			body TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			claim_token TEXT,
			completed_at TEXT
		);

		CREATE INDEX IF NOT EXISTS architect_requests_status_id_idx
		ON architect_requests(status, id);

		CREATE TABLE IF NOT EXISTS supervisor_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_session_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			deadline_at TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			claim_token TEXT,
			completed_at TEXT,
			response_json TEXT
		);

		CREATE INDEX IF NOT EXISTS supervisor_requests_priority_idx
		ON supervisor_requests(status, kind, id);

		CREATE TABLE IF NOT EXISTS shared_channel_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_session_id TEXT NOT NULL,
			sender_agent_id TEXT,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS shared_channel_messages_id_idx
		ON shared_channel_messages(id);

		CREATE INDEX IF NOT EXISTS shared_channel_messages_created_at_idx
		ON shared_channel_messages(created_at);

		CREATE TABLE IF NOT EXISTS shared_channel_cursors (
			session_id TEXT NOT NULL,
			agent_id_key TEXT NOT NULL,
			last_seen_id INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_id, agent_id_key)
		);
	`;
