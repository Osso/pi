import type { ResponseUsage } from "openai/resources/responses/responses.js";
import type { Usage } from "../types.ts";

/** OpenAI includes cached and cache-write tokens in `input_tokens`; report them separately. */
export function mapResponsesUsage(usage: ResponseUsage): Usage {
	const details: { cached_tokens?: number; cache_write_tokens?: number } = usage.input_tokens_details ?? {};
	const cachedTokens = details.cached_tokens || 0;
	const cacheWriteTokens = details.cache_write_tokens || 0;
	return {
		input: (usage.input_tokens || 0) - cachedTokens - cacheWriteTokens,
		output: usage.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: usage.output_tokens_details?.reasoning_tokens || 0,
		totalTokens: usage.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
