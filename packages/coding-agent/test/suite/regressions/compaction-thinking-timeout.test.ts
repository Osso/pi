import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness } from "../harness.ts";

it("keeps a saved manual compaction when the resumed turn exceeds the thinking deadline", async () => {
	const harness = await createHarness({
		thinkingPhaseTimeoutMs: 50,
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("compaction", async (event) => ({
					compaction: {
						summary: "Earlier work summarized",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	try {
		const stalledResponse: FauxResponseFactory = async (_context, options) => {
			await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
			return fauxAssistantMessage("Never delivered");
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("end_turn", { reason: "done" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Interrupted", { stopReason: "aborted" }),
			stalledResponse,
			stalledResponse,
		]);
		await harness.session.prompt("Earlier work");
		await harness.session.prompt("Continue the task");

		const compactionEnds: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") compactionEnds.push(event);
		});
		await expect(harness.session.compact()).rejects.toThrow("Main session thinking phase exceeded 20 minutes");

		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0].result?.summary).toBe("Earlier work summarized");
		expect(compactionEnds[0].errorMessage).toBeUndefined();
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "compaction" && entry.summary === "Earlier work summarized"),
		).toBe(true);
	} finally {
		harness.cleanup();
	}
});
