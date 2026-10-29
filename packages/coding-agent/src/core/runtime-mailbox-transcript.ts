import type { RuntimeMailboxStoreRef } from "./session-control-db.ts";
import type { SessionEntry } from "./session-manager.ts";

export const RUNTIME_MAILBOX_ACCEPTANCE_CUSTOM_TYPE = "runtime_mailbox_acceptance";

export type RuntimeMailboxAcceptanceCheck = (ref: RuntimeMailboxStoreRef) => boolean;

export function mailboxStoreRefsEqual(left: RuntimeMailboxStoreRef, right: RuntimeMailboxStoreRef): boolean {
	return left.sessionPath === right.sessionPath && left.messageId === right.messageId;
}

function entryMailboxStoreRefs(entry: SessionEntry): RuntimeMailboxStoreRef[] {
	if (entry.type === "message") return entry.mailboxStoreRefs ?? [];
	if (entry.type !== "custom" || entry.customType !== RUNTIME_MAILBOX_ACCEPTANCE_CUSTOM_TYPE) return [];
	const data = entry.data as { mailboxStoreRefs?: RuntimeMailboxStoreRef[] } | undefined;
	return data?.mailboxStoreRefs ?? [];
}

/** Checks every loaded entry, including entries no longer on the active branch. */
export function isMailboxStoreRefAccepted(entries: readonly SessionEntry[], ref: RuntimeMailboxStoreRef): boolean {
	return entries.some((entry) =>
		entryMailboxStoreRefs(entry).some((accepted) => mailboxStoreRefsEqual(accepted, ref)),
	);
}
