const STALE_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

export function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(STALE_CONTEXT_ERROR_PREFIX);
}
