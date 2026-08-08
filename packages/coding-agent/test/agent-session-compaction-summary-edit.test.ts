import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./suite/harness.ts";
import { createHarness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("AgentSession compaction summary editing", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("refreshes the active model context after editing a compaction summary", async () => {
		harness = await createHarness();
		harness.sessionManager.appendMessage(userMsg("old prompt"));
		harness.sessionManager.appendMessage(assistantMsg("old answer"));
		const firstKeptEntryId = harness.sessionManager.appendMessage(userMsg("retained prompt"));
		harness.sessionManager.appendMessage(assistantMsg("retained answer"));
		const compactionId = harness.sessionManager.appendCompaction("generated summary", firstKeptEntryId, 12_345);
		harness.sessionManager.appendMessage(userMsg("later prompt"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		harness.session.updateCompactionSummary(compactionId, "edited summary");

		expect(harness.session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: "edited summary",
		});
	});
});
