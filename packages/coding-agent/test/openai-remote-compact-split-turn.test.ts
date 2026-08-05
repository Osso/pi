import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { OPENAI_CODEX_GC_MODELS } from "../../ai/src/providers/openai-codex-gc.models.ts";
import { buildOpenAICompactPayload, handleCompaction } from "../extensions/openai-remote-compact/src/index.ts";
import type { CompactionPreparation } from "../src/core/compaction/index.ts";
import type { CompactionEvent, ExtensionContext } from "../src/core/extensions/types.ts";

function createCodexJwt(): string {
	return [
		"header",
		Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString(
			"base64url",
		),
		"signature",
	].join(".");
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OpenAI remote split-turn compaction", () => {
	it("pins the opening user message when limiting split-turn compact input", async () => {
		const openingRequest = "opening request must remain verbatim";
		const model = OPENAI_CODEX_GC_MODELS["gpt-5.6-sol"];
		const toolCycles: AgentMessage[] = Array.from({ length: 110 }, (_, index) => {
			const toolCallId = `call-${index}|item-${index}`;
			return [
				{
					role: "assistant" as const,
					content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { index } }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse" as const,
					timestamp: index * 2 + 2,
				},
				{
					role: "toolResult" as const,
					toolCallId,
					toolName: "read",
					content: [{ type: "text" as const, text: `result ${index} ${"x".repeat(4_000)}` }],
					isError: false,
					timestamp: index * 2 + 3,
				},
			];
		}).flat();
		const preparation: CompactionPreparation = {
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			firstKeptEntryId: "kept-1",
			isSplitTurn: true,
			messagesToSummarize: [],
			settings: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 },
			tokensBefore: 371_525,
			turnPrefixMessages: [{ role: "user", content: openingRequest, timestamp: 1 }, ...toolCycles],
		};
		let requestPayload: { input: Array<Record<string, unknown>> } | undefined;
		globalThis.fetch = (async (_url, init) => {
			requestPayload = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>> };
			return new Response(
				JSON.stringify({ output: [{ type: "compaction_summary", encrypted_content: "encrypted" }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const event = {
			type: "compaction",
			preparation,
			branchEntries: [],
			reason: "overflow",
			willRetry: true,
			signal: new AbortController().signal,
		} satisfies CompactionEvent;
		const ctx = {
			model,
			getSystemPrompt: () => "system prompt",
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({
					ok: true as const,
					apiKey: createCodexJwt(),
					headers: undefined,
				}),
			},
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;

		const result = await handleCompaction(event, ctx);

		expect(result?.compaction).toBeDefined();
		expect(requestPayload).toBeDefined();
		const input = requestPayload!.input;
		const serializedInput = JSON.stringify(input);
		const callIds = new Set(
			input.flatMap((item) =>
				item.type === "function_call" && typeof item.call_id === "string" ? [item.call_id] : [],
			),
		);
		const outputIds = new Set(
			input.flatMap((item) =>
				item.type === "function_call_output" && typeof item.call_id === "string" ? [item.call_id] : [],
			),
		);
		expect(serializedInput.length).toBeLessThanOrEqual(400_000);
		expect(serializedInput.split(openingRequest)).toHaveLength(2);
		expect([...callIds].sort()).toEqual([...outputIds].sort());
	});

	it("reserves split-turn opening-user budget ahead of prior native history", () => {
		const openingRequest = "opening request must remain verbatim";
		const openingMessage: AgentMessage = { role: "user", content: openingRequest, timestamp: 1 };
		const previousReplacementHistory = [
			{ role: "user", content: [{ type: "input_text", text: "x".repeat(399_900) }] },
		];

		const payload = buildOpenAICompactPayload(
			OPENAI_CODEX_GC_MODELS["gpt-5.6-sol"],
			[openingMessage],
			"system prompt",
			previousReplacementHistory,
			{ pinnedMessages: [openingMessage] },
		);
		const serializedInput = JSON.stringify(payload.input);

		expect(serializedInput.length).toBeLessThanOrEqual(400_000);
		expect(serializedInput.split(openingRequest)).toHaveLength(2);
	});
});
