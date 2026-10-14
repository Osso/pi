import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

export const CODEX_FALLBACK_PROVIDERS = new Map([
	["openai-codex", ["openai-codex-gc", "openai-codex-team"]],
	["openai-codex-gc", ["openai-codex", "openai-codex-team"]],
	["openai-codex-team", ["openai-codex", "openai-codex-gc"]],
]);

const QUOTA_EXHAUSTION_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing (?:limit|quota|exhausted)/i;

export function isQuotaExhaustionError(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" && !!message.errorMessage && QUOTA_EXHAUSTION_PATTERN.test(message.errorMessage)
	);
}
