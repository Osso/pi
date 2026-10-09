import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function createUsageMessage(harness: Harness, totalTokens: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("response"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function seedHistory(harness: Harness): void {
	for (let i = 0; i < 4; i++) {
		harness.sessionManager.appendMessage({ role: "user", content: `history ${i}`, timestamp: Date.now() - 1000 });
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession percentage compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each([true, false])(
		"uses percentage boundary with built-in compaction enabled=%s and preserves extension handling",
		async (enabled) => {
			const harness = await createHarness({
				noSupervisor: true,
				models: [{ id: "percentage-model", contextWindow: 200_000 }],
				settings: { compaction: { enabled, thresholdPercent: 50 } },
				extensionFactories: [
					(pi) => {
						pi.on("compaction", async (event) => ({
							compaction: {
								summary: "percentage boundary summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			harness.getModel().autoCompactionThreshold = 180_000;
			seedHistory(harness);
			const session = harness.session as unknown as {
				_checkCompaction(message: AssistantMessage, postRunCheck: boolean): Promise<boolean>;
			};
			await session._checkCompaction(createUsageMessage(harness, 99_999), false);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			await session._checkCompaction(createUsageMessage(harness, 100_000), false);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(harness.session.messages[0]).toMatchObject({
				role: "compactionSummary",
				summary: "percentage boundary summary",
			});
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "threshold", aborted: false });
		},
	);

	it("does not invoke built-in summarization when disabled without an extension", async () => {
		const harness = await createHarness({
			noSupervisor: true,
			models: [{ id: "percentage-disabled", contextWindow: 200_000 }],
			settings: { compaction: { enabled: false, thresholdPercent: 50 } },
		});
		harnesses.push(harness);
		seedHistory(harness);
		const session = harness.session as unknown as {
			_checkCompaction(message: AssistantMessage, postRunCheck: boolean): Promise<boolean>;
		};
		await session._checkCompaction(createUsageMessage(harness, 100_000), false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			errorMessage:
				"Auto-compaction failed: Built-in compaction is disabled; enable compaction or configure a compaction extension",
		});
	});
});
