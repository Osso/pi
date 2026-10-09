const RETRY_JITTER_RATIO = 0.2;
const RETRY_BACKOFF_FACTOR = 2;

/** Exponential retry delay with symmetric 20% jitter and a hard ceiling. */
export function calculateRetryDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxBackoffMs: number,
	randomValue: number,
): number {
	if (baseDelayMs === 0) return 0;
	const exponentialDelayMs = Math.min(maxBackoffMs, baseDelayMs * RETRY_BACKOFF_FACTOR ** (attempt - 1));
	const jitterFactor = 1 - RETRY_JITTER_RATIO + randomValue * (2 * RETRY_JITTER_RATIO);
	const jitteredDelayMs = exponentialDelayMs * jitterFactor;
	return Math.min(maxBackoffMs, Math.round(jitteredDelayMs));
}
