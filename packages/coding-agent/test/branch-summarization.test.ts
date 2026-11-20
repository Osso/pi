import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary, prepareBranchEntries } from "../src/core/compaction/branch-summarization.ts";
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

	it("orders a compaction's files before the reads it kept verbatim", () => {
		const read = (id: string, path: string): SessionEntry => ({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-11-14T00:00:00.000Z",
			message: fauxAssistantMessage([{ type: "toolCall", id, name: "read", arguments: { path } }], {
				stopReason: "toolUse",
			}),
		});
		const entries: SessionEntry[] = [
			read("m0", "a.ts"),
			read("m1", "recent.ts"),
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: "2026-11-14T00:00:00.000Z",
				summary: "Read a.ts and old.ts",
				firstKeptEntryId: "m1",
				tokensBefore: 100,
				details: { readFiles: ["a.ts", "old.ts"], modifiedFiles: [] },
			},
		];

		const { readFiles } = computeFileLists(prepareBranchEntries(entries).fileOps);

		expect(readFiles).toEqual(["a.ts", "old.ts", "recent.ts"]);
	});
});

describe("generateBranchSummary", () => {
	const model: Model<"anthropic-messages"> = {
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
	const entries: SessionEntry[] = [
		{
			type: "message",
			id: "branch-user",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: { role: "user", content: "Abandoned request", timestamp: 1 },
		},
	];

	// Upstream #8845: a 2048-token cap cut off ordinary branch summaries.
	it.each([
		[8192, 4096],
		[1024, 1024],
	])("caps summary output at 4096 tokens or the model limit (model limit %i)", async (modelLimit, expected) => {
		let requestedMaxTokens: number | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestedMaxTokens = options?.maxTokens;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("summary") }));
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model: { ...model, maxTokens: modelLimit },
			apiKey: "test-key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBeUndefined();
		expect(requestedMaxTokens).toBe(expected);
	});

	it("keeps the file lists when no message fits the history budget", async () => {
		const branch: SessionEntry[] = [
			fauxAssistantMessage([{ type: "toolCall", id: "r", name: "read", arguments: { path: "package.json" } }], {
				stopReason: "toolUse",
			}),
			{ role: "user" as const, content: "abcd".repeat(4000), timestamp: 2 },
		].map((message, index) => ({
			type: "message",
			id: `e${index}`,
			parentId: null,
			timestamp: "2026-11-14T00:00:00.000Z",
			message,
		}));

		const result = await generateBranchSummary(branch, {
			model: { ...model, contextWindow: 2000 },
			reserveTokens: 1000,
			apiKey: "test-key",
			signal: new AbortController().signal,
		});

		expect(result.readFiles).toEqual(["package.json"]);
		expect(result.modifiedFiles).toEqual([]);
		expect(result.summary).toContain("<read-files>\npackage.json\n</read-files>");
	});

	it("rejects a summary cut off at the token cap instead of persisting partial text", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			const message = { ...fauxAssistantMessage("partial summar"), stopReason: "length" as const };
			queueMicrotask(() => stream.push({ type: "done", reason: "length", message }));
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			apiKey: "test-key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.summary).toBeUndefined();
		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});
});
