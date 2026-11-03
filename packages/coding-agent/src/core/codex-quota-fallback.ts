import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

export const CODEX_FALLBACK_PROVIDERS = new Map([
	["openai-codex", ["openai-codex-gc", "openai-codex-team"]],
	["openai-codex-gc", ["openai-codex", "openai-codex-team"]],
	["openai-codex-team", ["openai-codex", "openai-codex-gc"]],
]);

const OPENAI_API_PROVIDERS = ["openai", "openai-secondary"];

export function getOpenAIQuotaFallbackProviders(provider: string): string[] | undefined {
	const codexFallbacks = CODEX_FALLBACK_PROVIDERS.get(provider);
	if (codexFallbacks) return [...OPENAI_API_PROVIDERS, ...codexFallbacks];
	if (!OPENAI_API_PROVIDERS.includes(provider)) return undefined;
	return [...OPENAI_API_PROVIDERS.filter((candidate) => candidate !== provider), ...CODEX_FALLBACK_PROVIDERS.keys()];
}

const QUOTA_EXHAUSTION_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing (?:limit|quota|exhausted)/i;

export function isQuotaExhaustionError(message: AssistantMessage): boolean {
	return (
		message.stopReason === "error" && !!message.errorMessage && QUOTA_EXHAUSTION_PATTERN.test(message.errorMessage)
	);
}
