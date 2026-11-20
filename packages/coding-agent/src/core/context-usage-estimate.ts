import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateContextTokens, estimateTokens } from "./compaction/index.ts";
import { getLatestCompactionEntry, type SessionEntry } from "./session-manager.ts";

/**
 * Context tokens of a branch whose context is `messages`.
 * Usage reported before the latest compaction describes the old context, so until an assistant reply after it
 * reports usage, the rebuilt context is estimated from message content.
 */
export function estimateBranchContextTokens(branchEntries: SessionEntry[], messages: AgentMessage[]): number {
	const latestCompaction = getLatestCompactionEntry(branchEntries);
	if (latestCompaction) {
		const hasPostCompactionUsage = branchEntries
			.slice(branchEntries.lastIndexOf(latestCompaction) + 1)
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.stopReason !== "aborted" &&
					entry.message.stopReason !== "error" &&
					calculateContextTokens(entry.message.usage) > 0,
			);
		if (!hasPostCompactionUsage) return messages.reduce((tokens, message) => tokens + estimateTokens(message), 0);
	}
	return estimateContextTokens(messages).tokens;
}
