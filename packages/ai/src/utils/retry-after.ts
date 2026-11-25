/** Default cap for provider-requested retry delays. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

const RETRY_AFTER_TEXT_PATTERN =
	/\b(?:(?:try again|retry) in|reset after)\s+(?=\d+\s*[hm]|\d+(?:\.\d+)?\s*s)(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?\b/i;
const RETRY_INFO_DELAY_PATTERN = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i;

/**
 * Extract the provider's requested retry delay from HTTP response headers.
 *
 * Prefers the millisecond form, then seconds, then an HTTP date. Invalid or
 * absent values return undefined so callers fall back to their own backoff.
 */
export function getRetryAfterMs(headers: Headers | null | undefined): number | undefined {
	if (!headers) return undefined;

	// Number("") is 0, so blank values must be rejected before numeric parsing.
	const retryAfterMs = headers.get("retry-after-ms")?.trim();
	if (retryAfterMs) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) return Math.max(0, millis);
	}

	const retryAfter = headers.get("retry-after")?.trim();
	if (!retryAfter) return undefined;

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
	if (match && (match[1] !== undefined || match[2] !== undefined || match[3] !== undefined)) {
		const millis = Number(match[1] ?? 0) * 3_600_000 + Number(match[2] ?? 0) * 60_000 + Number(match[3] ?? 0) * 1000;
		return Number.isFinite(millis) ? Math.max(0, Math.round(millis)) : undefined;
	}

	const retryInfoMatch = RETRY_INFO_DELAY_PATTERN.exec(text);
	if (!retryInfoMatch) return undefined;
	const millis = Number(retryInfoMatch[1]) * 1000;
	return Number.isFinite(millis) ? Math.max(0, Math.round(millis)) : undefined;
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
