/** Default cap for provider-requested retry delays. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Extract the provider's requested retry delay from HTTP response headers.
 *
 * Prefers the millisecond form, then seconds, then an HTTP date. Invalid or
 * absent values return undefined so callers fall back to their own backoff.
 */
export function getRetryAfterMs(headers: Headers | null | undefined): number | undefined {
	if (!headers) return undefined;

	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) return Math.max(0, millis);
	}

	const retryAfter = headers.get("retry-after");
	if (retryAfter === null) return undefined;

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

	return undefined;
}

/** Requested retry delay carried by a provider or SDK error response. */
export function getErrorRetryAfterMs(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const headers = (error as { headers?: unknown }).headers;
	return headers instanceof Headers ? getRetryAfterMs(headers) : undefined;
}
