import { readFileSync } from "node:fs";
import type { RuntimeMailboxStoreRef } from "./session-control-db.ts";
import type { FileEntry } from "./session-manager.ts";

export const RUNTIME_MAILBOX_ACCEPTANCE_CUSTOM_TYPE = "runtime_mailbox_acceptance";

export function mailboxStoreRefsEqual(left: RuntimeMailboxStoreRef, right: RuntimeMailboxStoreRef): boolean {
	return left.sessionPath === right.sessionPath && left.messageId === right.messageId;
}

/** Inspect the whole transcript, including entries no longer on the active branch. */
export function readAcceptedRuntimeMailboxStoreRefs(sessionPath: string | undefined): RuntimeMailboxStoreRef[] {
	if (!sessionPath) return [];
	let transcript: string;
	try {
		transcript = readFileSync(sessionPath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const refs: RuntimeMailboxStoreRef[] = [];
	// Only complete JSONL records are durable; a crash may leave a partial last line.
	const lines = transcript.split("\n");
	lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as FileEntry;
		if (entry.type === "message") refs.push(...(entry.mailboxStoreRefs ?? []));
		if (entry.type === "custom" && entry.customType === RUNTIME_MAILBOX_ACCEPTANCE_CUSTOM_TYPE) {
			const data = entry.data as { mailboxStoreRefs?: RuntimeMailboxStoreRef[] } | undefined;
			refs.push(...(data?.mailboxStoreRefs ?? []));
		}
	}
	return refs;
}
