import type { AssistantMessage } from "@earendil-works/pi-ai";
import { classifyProviderError } from "@earendil-works/pi-ai/compat";

/** Waits before each repeat; jitter adds up to a quarter of the delay. */
export const SUMMARIZATION_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

function sleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, delayMs);
		signal?.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
	});
}

/**
 * Repeats a summarization request after a transient provider failure (overload, 5xx, dropped connection).
 * Rate limits keep the compaction cooldown; deterministic failures return at once.
 */
export async function retryTransientSummarization(
	request: () => Promise<AssistantMessage>,
	signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
	let response = await request();
	for (const delayMs of SUMMARIZATION_RETRY_DELAYS_MS) {
		if (classifyProviderError(response).kind !== "transient" || signal?.aborted) return response;
		await sleep(delayMs * (1 + Math.random() * 0.25), signal);
		if (signal?.aborted) return response;
		response = await request();
	}
	return response;
}
