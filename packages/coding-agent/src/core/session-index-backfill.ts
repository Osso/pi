import { normalizePath } from "../utils/paths.ts";
import { isSessionRootIndexed, listSessionMetadata, markSessionRootIndexed } from "./session-control-db.ts";
import type { SessionInfo } from "./session-manager.ts";

/**
 * Index every transcript under a session root once. The index becomes authoritative for that root only after this
 * full scan, so sessions written before the index existed (a new or reset state DB) stay discoverable. Rows already in
 * the index are kept as they are: they can hold newer state (cwd, names, archive) than the transcript header.
 */
export async function backfillSessionIndex(
	controlDbPath: string,
	root: string,
	scan: () => Promise<SessionInfo[]>,
	write: (sessions: SessionInfo[]) => void,
): Promise<void> {
	if (isSessionRootIndexed(controlDbPath, root)) return;
	const sessions = await scan();
	const indexedPaths = new Set(
		listSessionMetadata(controlDbPath).map((metadata) => normalizePath(metadata.sessionPath)),
	);
	write(sessions.filter((session) => !indexedPaths.has(normalizePath(session.path))));
	markSessionRootIndexed(controlDbPath, root);
}
