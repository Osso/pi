/** Default cap for provider-requested retry delays. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

const RETRY_AFTER_TEXT_PATTERN = /\btry again in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)/i;

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

/**
 * Provider-stated delay embedded in an error message, for responses that carry the limit
 * in a stream event instead of HTTP headers, e.g. "Please try again in 142h36m11.52s".
 */
export function getRetryAfterMsFromText(text: string | undefined): number | undefined {
	if (!text) return undefined;
	const match = RETRY_AFTER_TEXT_PATTERN.exec(text);
	if (!match) return undefined;
	const millis = Number(match[1] ?? 0) * 3_600_000 + Number(match[2] ?? 0) * 60_000 + Number(match[3]) * 1000;
	return Number.isFinite(millis) ? Math.max(0, millis) : undefined;
}

/** Requested retry delay carried by a provider or SDK error response. */
export function getErrorRetryAfterMs(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const headers = (error as { headers?: unknown }).headers;
	if (headers instanceof Headers) {
		const fromHeaders = getRetryAfterMs(headers);
		if (fromHeaders !== undefined) return fromHeaders;
	}
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" ? getRetryAfterMsFromText(message) : undefined;
}
