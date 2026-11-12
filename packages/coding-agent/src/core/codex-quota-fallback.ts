export { isQuotaExhaustionError } from "@earendil-works/pi-ai/compat";

export const CODEX_FALLBACK_PROVIDERS = new Map([
	["openai-codex", ["openai-codex-gc", "openai-codex-team"]],
	["openai-codex-gc", ["openai-codex", "openai-codex-team"]],
	["openai-codex-team", ["openai-codex", "openai-codex-gc"]],
]);
