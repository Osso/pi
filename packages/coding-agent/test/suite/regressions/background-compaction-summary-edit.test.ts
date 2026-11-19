import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("speculative background compaction after a summary edit", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("does not install a cached compaction that merged the summary before the edit", async () => {
		const largeTool: AgentTool = {
			name: "large_tool",
			label: "Large Tool",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(10_000) }], details: {} }),
		};
		let releaseGeneration: () => void = () => {};
		const generationReleased = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		let generationEnded: () => void = () => {};
		const backgroundEnded = new Promise<void>((resolve) => {
			generationEnded = resolve;
		});
		const created = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentMessages: 1, backgroundStartTokens: 2_500, thresholdTokens: 64_000 },
			},
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 100 }],
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => {
						const merged = `Merged: ${event.preparation.previousSummary}`;
						await generationReleased;
						return {
							compaction: {
								summary: merged,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					pi.on("background_compaction_end", () => generationEnded());
				},
			],
		});
		harness = created;
		created.sessionManager.appendMessage(userMsg("old prompt"));
		created.sessionManager.appendMessage(assistantMsg("old answer"));
		const firstKeptEntryId = created.sessionManager.appendMessage(userMsg("retained prompt"));
		created.sessionManager.appendMessage(assistantMsg("retained answer"));
		const compactionId = created.sessionManager.appendCompaction("Destination is Paris.", firstKeptEntryId, 12_345);
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		created.setResponses([
			fauxAssistantMessage(fauxToolCall("large_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("ok"),
		]);

		await created.session.prompt("run the tool");
		created.session.updateCompactionSummary(compactionId, "Destination is Oslo.");
		releaseGeneration();
		await backgroundEnded;
		await created.session.prompt("where are we going?");

		const summaries = created.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "compaction" ? [entry.summary] : []));
		expect(summaries.filter((summary) => summary.includes("Paris"))).toEqual([]);
		expect(created.session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("Destination is Oslo."),
		});
	});
});
