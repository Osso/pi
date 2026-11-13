import { describe, expect, test } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Context, Model } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-4.1-mini",
		name: "GPT 4.1 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

describe("OpenAI Responses native context", () => {
	test("inserts provider-native compaction history before regular messages", () => {
		const model = createModel();
		const nativeItems = [
			{ role: "user", content: [{ type: "input_text", text: "compacted" }] },
			{ type: "compaction", encrypted_content: "encrypted" },
		];
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "synthetic summary" }],
					providerNative: {
						provider: "openai",
						api: "openai-responses",
						format: "openai.responses.input",
						value: nativeItems,
					},
					timestamp: 1,
				},
				{ role: "user", content: "recent", timestamp: 2 },
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]), {
			includeSystemPrompt: false,
		});

		expect(input).toEqual([...nativeItems, { role: "user", content: [{ type: "input_text", text: "recent" }] }]);
	});

	test("ignores malformed or non-reasoning thinkingSignature payloads instead of throwing", () => {
		const model = createModel();
		const validReasoning = { id: "rs_1", type: "reasoning", summary: [] };
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "bad json", thinkingSignature: "{not-json" },
						{ type: "thinking", thinking: "wrong shape", thinkingSignature: '{"type":"other"}' },
						{ type: "thinking", thinking: "valid", thinkingSignature: JSON.stringify(validReasoning) },
						{ type: "text", text: "ok" },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-4.1-mini",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]), {
			includeSystemPrompt: false,
		});

		expect(input).toEqual([
			validReasoning,
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "ok", annotations: [] }],
				status: "completed",
				id: "msg_pi_0",
				phase: undefined,
			},
		]);
	});
});
