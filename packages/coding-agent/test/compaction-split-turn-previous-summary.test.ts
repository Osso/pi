import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, expect, it } from "vitest";
import { compact, prepareCompaction } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

let faux: FauxProviderRegistration;
let requests: Context[];

beforeEach(() => {
	requests = [];
	faux = registerFauxProvider({ api: "split-turn-faux", provider: "split-turn-faux" });
	faux.setResponses(
		Array.from({ length: 2 }, () => (context: Context) => {
			requests.push(context);
			return fauxAssistantMessage("Turn prefix summary.");
		}),
	);
});

afterEach(() => faux.unregister());

/** One long agentic turn that started before the previous compaction and is still running. */
function buildLongTurnAfterCompaction(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	const add = (entry: Omit<SessionEntry, "id" | "parentId" | "timestamp">) => {
		const id = `entry-${entries.length}`;
		entries.push({
			...entry,
			id,
			parentId,
			timestamp: new Date(entries.length * 1000).toISOString(),
		} as SessionEntry);
		parentId = id;
		return id;
	};
	const addMessage = (message: AgentMessage) => add({ type: "message", message } as SessionEntry);
	const addToolStep = (step: number) => {
		addMessage(fauxAssistantMessage([fauxToolCall("read", { path: `step-${step}.txt` }, { id: `call-${step}` })]));
		addMessage({
			role: "toolResult",
			toolCallId: `call-${step}`,
			toolName: "read",
			content: [{ type: "text", text: `contents of step ${step}` }],
			isError: false,
			timestamp: step,
		});
	};

	addMessage({ role: "user", content: "Old request summarized by the first compaction", timestamp: 0 });
	addMessage(fauxAssistantMessage("Old answer"));
	const longTurnStart = addMessage({ role: "user", content: "Refactor the parser", timestamp: 1 });
	for (let step = 1; step <= 3; step++) addToolStep(step);
	add({
		type: "compaction",
		summary: "FIRST SUMMARY: user wants the parser refactored; deadline Friday.",
		firstKeptEntryId: longTurnStart,
		tokensBefore: 50_000,
	} as SessionEntry);
	for (let step = 4; step <= 8; step++) addToolStep(step);
	return entries;
}

it("keeps the previous summary when a repeated compaction splits the turn the previous one kept", async () => {
	const preparation = prepareCompaction(buildLongTurnAfterCompaction(), {
		enabled: true,
		reserveTokens: 2000,
		keepRecentMessages: 4,
	});
	if (!preparation) throw new Error("Expected a compaction preparation");
	expect(preparation.isSplitTurn).toBe(true);

	const result = await compact(preparation, faux.getModel(), "test-key");

	expect(result.summary).toContain("FIRST SUMMARY: user wants the parser refactored; deadline Friday.");
	expect(result.summary).toContain("Turn prefix summary.");
	expect(result.summary).not.toContain("No prior history.");
	expect(requests).toHaveLength(1);
});

it("carries the previous summary forward with one current file list", async () => {
	const entries = buildLongTurnAfterCompaction();
	const previous = entries.find((entry) => entry.type === "compaction");
	if (previous?.type !== "compaction") throw new Error("Expected the first compaction");
	previous.summary += "\n\n<read-files>\nold/read-0.ts\nstep-1.txt\n</read-files>";
	previous.details = { readFiles: ["old/read-0.ts", "step-1.txt"], modifiedFiles: [] };
	const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 2000, keepRecentMessages: 4 });
	if (!preparation) throw new Error("Expected a compaction preparation");
	expect(preparation.isSplitTurn).toBe(true);

	const result = await compact(preparation, faux.getModel(), "test-key");

	expect(result.summary.match(/<read-files>/g)).toHaveLength(1);
	expect(result.summary).toContain("FIRST SUMMARY: user wants the parser refactored; deadline Friday.");
	expect(result.summary.match(/step-1\.txt/g)).toHaveLength(1);
});
