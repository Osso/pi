import type { AssistantMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "./compaction/compaction.ts";

const MINUTE_MS = 60_000;

/**
 * Provider prompt-cache lifetime by request API, measured from the start of the last request.
 * Providers absent here get no idle compaction.
 */
const PROMPT_CACHE_TTL_MS_BY_API: Readonly<Record<string, number>> = {
	// Claude Agent SDK sdk.d.ts: "1 hour on a Claude subscription within its usage limits".
	"claude-bridge": 60 * MINUTE_MS,
	// OpenAI prompt-caching guide: GPT-5.6+ caches stay eligible for at least 30 minutes. The ChatGPT
	// Codex backend does not document its retention; 30 minutes is the user-approved assumption.
	"openai-codex-responses": 30 * MINUTE_MS,
};

/** Compact once this fraction of the cache lifetime has elapsed, leaving time to finish before expiry. */
const IDLE_COMPACTION_TTL_FRACTION = 0.9;

/** Smaller contexts are cheap to re-cache and lose detail when summarized. */
const IDLE_COMPACTION_MIN_CONTEXT_TOKENS = 200_000;

/**
 * Time at which an idle session whose latest request is `message` should compact, or undefined when
 * its provider has no known cache lifetime or its context is below the idle-compaction minimum.
 */
export function computeIdleCompactionDueAt(message: AssistantMessage): number | undefined {
	const cacheTtlMs = PROMPT_CACHE_TTL_MS_BY_API[message.api];
	if (cacheTtlMs === undefined) return undefined;
	if (calculateContextTokens(message.usage) < IDLE_COMPACTION_MIN_CONTEXT_TOKENS) return undefined;
	return message.timestamp + cacheTtlMs * IDLE_COMPACTION_TTL_FRACTION;
}
