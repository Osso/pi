/** Exponential retry delay with symmetric 20% jitter and a hard ceiling. */
export function calculateRetryDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	randomValue: number,
): number {
	if (baseDelayMs === 0) return 0;
	const exponentialDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
	const jitteredDelayMs = exponentialDelayMs * (0.8 + randomValue * 0.4);
	return Math.min(maxDelayMs, Math.round(jitteredDelayMs));
}
