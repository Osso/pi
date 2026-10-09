export const MAILBOX_MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Missing or unparseable creation times expire rather than borrowing a mutation timestamp. */
export function isMailboxMessageExpired(createdAt: unknown, now: number): boolean {
	if (typeof createdAt !== "string") return true;
	const createdAtMs = Date.parse(createdAt);
	return !Number.isFinite(createdAtMs) || now - createdAtMs >= MAILBOX_MESSAGE_RETENTION_MS;
}
