import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// Upstream #8328: a provider that reports no usage (some OpenAI-compatible endpoints omit streaming usage)
// never reached threshold compaction, because the check required earlier provider usage to estimate from.
// The faux provider always estimates usage, so the check runs directly, as in compaction-threshold-tokens.test.ts.
describe("regression #8328: threshold compaction without provider usage", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function checkAfterZeroUsageReply(prompt: string): Promise<Harness> {
		const harness = await createHarness({
			noSupervisor: true,
			models: [{ id: "zero-usage", contextWindow: 128_000 }],
			settings: { compaction: { enabled: true, thresholdTokens: 500, keepRecentMessages: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "zero usage summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const reply: AssistantMessage = {
			...fauxAssistantMessage("response"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		for (let i = 0; i < 4; i++) {
			harness.sessionManager.appendMessage({ role: "user", content: `history ${i}`, timestamp: Date.now() - 1000 });
		}
		harness.sessionManager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() - 500 });
		harness.sessionManager.appendMessage(reply);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const session = harness.session as unknown as {
			_checkCompaction(message: AssistantMessage, postRunCheck: boolean): Promise<boolean>;
		};
		await session._checkCompaction(reply, false);
		return harness;
	}

	const compactions = (harness: Harness) =>
		harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

	it("compacts from the message-size estimate when no response reported usage", async () => {
		const harness = await checkAfterZeroUsageReply("x".repeat(4000));

		expect(compactions(harness)).toHaveLength(1);
		expect(harness.session.messages[0]).toMatchObject({ role: "compactionSummary", summary: "zero usage summary" });
	});

	it("does not compact when the message-size estimate is below the threshold", async () => {
		const harness = await checkAfterZeroUsageReply("short");

		expect(compactions(harness)).toHaveLength(0);
	});
});
