import type { SessionEntry } from "./session-manager.ts";

/**
 * Whether `entries` hold the whole context of `entryId`: its parent chain reaches the root or a compaction.
 * A reopened session loads only the entries from the latest compaction's kept prefix on, so a kept entry's
 * chain stops at a missing parent.
 */
export function hasContextAncestry(entries: ReadonlyMap<string, SessionEntry>, entryId: string): boolean {
	let entry = entries.get(entryId);
	while (entry) {
		if (entry.type === "compaction" || entry.parentId === null) return true;
		entry = entries.get(entry.parentId);
	}
	return false;
}
