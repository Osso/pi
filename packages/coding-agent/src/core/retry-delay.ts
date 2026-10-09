/** Exponential retry delay with symmetric 20% jitter and a hard ceiling. */
export function calculateRetryDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxBackoffMs: number,
	randomValue: number,
): number {
	if (baseDelayMs === 0) return 0;
	const exponentialDelayMs = Math.min(maxBackoffMs, baseDelayMs * 2 ** (attempt - 1));
	const jitteredDelayMs = exponentialDelayMs * (0.8 + randomValue * 0.4);
	return Math.min(maxBackoffMs, Math.round(jitteredDelayMs));
}
