import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./suite/harness.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";
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

	it("materializes an OpenAI-native checkpoint without mutating the persisted compaction", async () => {
		let requestMessages: Message[] | undefined;
		harness = await createHarness({
			fauxProvider: { api: "openai-responses", provider: "openai" },
		});
		harness.setResponses([
			(context) => {
				requestMessages = context.messages;
				return fauxAssistantMessage("Full plaintext continuation summary.\n\nAll decisions and remaining work.");
			},
		]);
		const firstKeptEntryId = harness.sessionManager.appendMessage(userMsg("retained prompt"));
		const providerNative = {
			provider: "openai",
			api: "openai-responses",
			format: "openai.responses.input" as const,
			value: [{ type: "compaction_summary", encrypted_content: "encrypted-native-checkpoint" }],
		};
		const details = {
			type: "openai-remote-compaction",
			version: 1,
			provider: "openai",
			api: "openai-responses",
			model: harness.getModel().id,
			endpoint: "https://api.openai.test/v1/responses/compact",
			replacementHistory: providerNative.value,
			replacementHistoryBytes: 128,
			replacementHistoryTokens: 32,
		};
		const compactionId = harness.sessionManager.appendCompaction(
			"OpenAI native compaction stored in session entry details.",
			firstKeptEntryId,
			12_345,
			details,
			true,
			321,
			providerNative,
		);
		const beforeMaterialization = structuredClone(harness.sessionManager.getEntry(compactionId));

		const result = await harness.session.materializeCompactionSummary(compactionId);

		expect(result).toEqual({
			aborted: false,
			summary: "Full plaintext continuation summary.\n\nAll decisions and remaining work.",
		});
		expect(requestMessages).toHaveLength(2);
		expect(requestMessages?.[0]).toMatchObject({ role: "user", providerNative });
		expect(getMessageText(requestMessages?.[1])).toContain("complete plaintext continuation summary");
		expect(harness.sessionManager.getEntry(compactionId)).toEqual(beforeMaterialization);
	});

	it("rejects native materialization when the active model cannot consume the checkpoint", async () => {
		harness = await createHarness();
		const firstKeptEntryId = harness.sessionManager.appendMessage(userMsg("retained prompt"));
		const compactionId = harness.sessionManager.appendCompaction(
			"OpenAI native compaction stored in session entry details.",
			firstKeptEntryId,
			12_345,
			undefined,
			true,
			undefined,
			{
				provider: "openai",
				api: "openai-responses",
				format: "openai.responses.input",
				value: [{ type: "compaction_summary", encrypted_content: "encrypted-native-checkpoint" }],
			},
		);

		await expect(harness.session.materializeCompactionSummary(compactionId)).rejects.toThrow(
			"requires an active openai/openai-responses model",
		);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
