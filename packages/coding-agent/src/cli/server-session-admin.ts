import { archivePersistedSession } from "../core/session-archive-storage.ts";
import { getControlDbPath, writeSessionName } from "../core/session-control-db.ts";
import type { CommandContext } from "./server-command.ts";
import { rpcCommand, sessionSummaries } from "./server-worker.ts";

/** Renames a session as the `pi -r` selector does; `name` absent or empty clears it. A server worker renames its own session. */
export async function handleRenameSession({
	frame,
	workers,
	publishUpdates,
	respond,
	fail,
}: CommandContext): Promise<void> {
	if (frame.name !== undefined && typeof frame.name !== "string")
		return fail("invalid_request", "name must be a string");
	const name = typeof frame.name === "string" && frame.name.trim() ? frame.name.trim() : undefined;
	const session = sessionSummaries(workers).find((entry) => entry.sessionId === frame.sessionId);
	if (!session?.sessionPath) return fail("not_found", "Session is not in the session directory");
	const worker = workers.get(session.sessionId);
	if (worker) {
		const command = name ? { type: "set_session_name", name } : { type: "clear_session_name" };
		const response = await rpcCommand(worker, command);
		if (!response.success) return fail("rename_failed", String(response.error ?? "the worker refused the name"));
	} else if (session.status !== "ended") {
		return fail("running", "The session runs in a terminal: rename it there");
	} else {
		writeSessionName(getControlDbPath(), session.sessionPath, name);
	}
	publishUpdates();
	return respond({ sessionId: session.sessionId, name: name ?? null });
}

/** Archives an ended session as `pi -r` does: its transcript is compressed and leaves the session list. */
export async function handleArchiveSession({
	frame,
	workers,
	publishUpdates,
	respond,
	fail,
}: CommandContext): Promise<void> {
	const session = sessionSummaries(workers).find((entry) => entry.sessionId === frame.sessionId);
	if (!session?.sessionPath) return fail("not_found", "Session is not in the session directory");
	if (session.status !== "ended") return fail("running", "Stop the session before archiving it");
	try {
		archivePersistedSession(getControlDbPath(), session.sessionPath);
	} catch (error) {
		return fail("archive_failed", error instanceof Error ? error.message : String(error));
	}
	publishUpdates();
	return respond({ sessionId: session.sessionId });
}
