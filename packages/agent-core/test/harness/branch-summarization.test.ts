import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../../src/harness/compaction/branch-summarization.ts";
import { computeFileLists } from "../../src/harness/compaction/utils.ts";
import type { SessionTreeEntry } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

describe("branch summarization file operations", () => {
	it.each([0, 1000])("tracks older tool calls independently of the %i-token budget", (tokenBudget) => {
		const recentReply = fauxAssistantMessage("Recent reply", { timestamp: 3 });
		const messages: AgentMessage[] = [
			fauxAssistantMessage(
				[
					{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "old-read.ts" } },
					{
						type: "toolCall",
						id: "write-old",
						name: "write",
						arguments: { path: "old-write.ts", content: "export const value = 1;" },
					},
				],
				{ stopReason: "toolUse", timestamp: 1 },
			),
			{ role: "user", content: "x".repeat(8000), timestamp: 2 },
			recentReply,
		];
		const entries: SessionTreeEntry[] = messages.map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "2026-11-14T00:00:00.000Z",
			message,
		}));

		const preparation = prepareBranchEntries(entries, tokenBudget);

		expect(computeFileLists(preparation.fileOps)).toEqual({
			readFiles: ["old-read.ts"],
			modifiedFiles: ["old-write.ts"],
		});
		expect(preparation.messages).toEqual(tokenBudget === 0 ? messages : [recentReply]);
	});
});
