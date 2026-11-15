import type { AssistantMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "./compaction/compaction.ts";

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

/**
 * Provider prompt-cache lifetime, measured from the start of the last request. The Claude and Codex
 * values are user-stated, not provider-documented:
 * - Claude models keep the cache 1 hour, through claude-bridge and through the Claude proxy.
 * - The ChatGPT Codex backend keeps it at least 12 hours.
 * Other providers get the shortest common default (Anthropic cache_control, OpenAI in-memory).
 */
function promptCacheTtlMs(message: AssistantMessage): number {
	if (message.model.startsWith("claude-")) return HOUR_MS;
	if (message.api === "openai-codex-responses") return 12 * HOUR_MS;
	return 5 * MINUTE_MS;
}

/** Compact once this fraction of the cache lifetime has elapsed, leaving time to finish before expiry. */
const IDLE_COMPACTION_TTL_FRACTION = 0.9;

/** Smaller contexts are cheap to re-cache and lose detail when summarized. */
const IDLE_COMPACTION_MIN_CONTEXT_TOKENS = 100_000;

/**
 * Time at which an idle session whose latest request is `message` should compact, or undefined when
 * its context is below the idle-compaction minimum.
 */
export function computeIdleCompactionDueAt(message: AssistantMessage): number | undefined {
	const cacheTtlMs = promptCacheTtlMs(message);
	if (calculateContextTokens(message.usage) < IDLE_COMPACTION_MIN_CONTEXT_TOKENS) return undefined;
	return message.timestamp + cacheTtlMs * IDLE_COMPACTION_TTL_FRACTION;
}
