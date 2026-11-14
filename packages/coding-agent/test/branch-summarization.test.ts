import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
import { computeFileLists } from "../src/core/compaction/utils.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

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
		const entries: SessionEntry[] = messages.map((message, index) => ({
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

	it("adds file lists from pi-generated compaction entries", () => {
		const compaction = (id: string, fromHook: boolean, file: string) => ({
			type: "compaction" as const,
			id,
			parentId: null,
			timestamp: "2026-11-14T00:00:00.000Z",
			summary: "Earlier work",
			firstKeptEntryId: id,
			tokensBefore: 100,
			details: { readFiles: [`${file}-read.ts`], modifiedFiles: [`${file}-modified.ts`] },
			fromHook,
		});
		const entries: SessionEntry[] = [compaction("pi", false, "pi"), compaction("hook", true, "hook")];

		const preparation = prepareBranchEntries(entries);

		expect(computeFileLists(preparation.fileOps)).toEqual({
			readFiles: ["pi-read.ts"],
			modifiedFiles: ["pi-modified.ts"],
		});
	});
});
