const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b|tokens per min/i;
const RETRY_HINT_PATTERN = /try again in\s+([\d.]+)\s*(ms|s|sec(?:ond)?s?|m|min(?:ute)?s?)/i;
const DEFAULT_COOLDOWN_MS = 60_000;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Cooldown before the next automatic compaction attempt after a rate-limited
 * summarization request. Honors a provider "try again in Ns" hint so repeated
 * turns do not resend the same large summary request while the limit holds.
 */
export const MAX_CONSECUTIVE_COMPACTION_FAILURES = 3;

export function compactionRetryCooldownMs(errorMessage: string): number | undefined {
	if (!RATE_LIMIT_PATTERN.test(errorMessage)) {
		return undefined;
	}
	const hint = RETRY_HINT_PATTERN.exec(errorMessage);
	if (!hint) {
		return DEFAULT_COOLDOWN_MS;
	}
	const value = Number(hint[1]);
	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_COOLDOWN_MS;
	}
	const unit = hint[2].toLowerCase();
	const factor = unit === "ms" ? 1 : unit.startsWith("m") ? 60_000 : 1_000;
	return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.round(value * factor)));
}
