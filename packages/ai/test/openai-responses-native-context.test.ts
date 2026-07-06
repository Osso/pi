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
});
