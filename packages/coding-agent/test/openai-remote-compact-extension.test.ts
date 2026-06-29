import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildOpenAICompactPayload,
	extractOpenAICompactDetails,
	isOpenAIResponsesModel,
	OPENAI_REMOTE_COMPACTION_SUMMARY,
	type OpenAIRemoteCompactionDetails,
	rewriteOpenAICompactionPayload,
} from "../extensions/openai-remote-compact/src/index.ts";
import type { CompactionEntry } from "../src/core/session-manager.ts";

function createOpenAIResponsesModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
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
		...overrides,
	};
}

function compactionEntry(details: OpenAIRemoteCompactionDetails): CompactionEntry<OpenAIRemoteCompactionDetails> {
	return {
		type: "compaction",
		id: "compact-1",
		parentId: "parent-1",
		timestamp: "2026-01-01T00:00:00Z",
		summary: OPENAI_REMOTE_COMPACTION_SUMMARY,
		firstKeptEntryId: "kept-1",
		tokensBefore: 1000,
		details,
	};
}

describe("openai remote compact extension", () => {
	it("only handles first-party OpenAI Responses models", () => {
		expect(isOpenAIResponsesModel(createOpenAIResponsesModel())).toBe(true);
		expect(isOpenAIResponsesModel({ ...createOpenAIResponsesModel(), provider: "github-copilot" })).toBe(false);
		expect(isOpenAIResponsesModel({ ...createOpenAIResponsesModel(), api: "anthropic-messages" })).toBe(false);
	});

	it("builds a /responses/compact payload from compacted messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-4.1-mini",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		];

		const payload = buildOpenAICompactPayload(createOpenAIResponsesModel(), messages, "system prompt", []);

		expect(payload).toMatchObject({
			model: "gpt-4.1-mini",
			instructions: "system prompt",
			tools: [],
			parallel_tool_calls: false,
		});
		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hi" }],
				status: "completed",
			},
		]);
	});

	it("extracts native replacement history from /responses/compact output", () => {
		const details = extractOpenAICompactDetails(
			createOpenAIResponsesModel(),
			{
				output: [
					{ role: "user", content: [{ type: "input_text", text: "hello" }] },
					{ type: "compaction", encrypted_content: "encrypted" },
				],
			},
			"https://api.openai.com/v1/responses/compact",
		);

		expect(details).toEqual({
			type: "openai-remote-compaction",
			version: 1,
			provider: "openai",
			model: "gpt-4.1-mini",
			endpoint: "https://api.openai.com/v1/responses/compact",
			replacementHistory: [
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "compaction", encrypted_content: "encrypted" },
			],
		});
	});

	it("rewrites synthetic compaction summary messages to native replacement history", () => {
		const details: OpenAIRemoteCompactionDetails = {
			type: "openai-remote-compaction",
			version: 1,
			provider: "openai",
			model: "gpt-4.1-mini",
			endpoint: "https://api.openai.com/v1/responses/compact",
			replacementHistory: [
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "compaction", encrypted_content: "encrypted" },
			],
		};
		const payload = {
			model: "gpt-4.1-mini",
			input: [
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${OPENAI_REMOTE_COMPACTION_SUMMARY}\n</summary>`,
						},
					],
				},
				{ role: "user", content: [{ type: "input_text", text: "recent" }] },
			],
		};

		const rewritten = rewriteOpenAICompactionPayload(payload, [compactionEntry(details)]);

		expect(rewritten).toEqual({
			model: "gpt-4.1-mini",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "compaction", encrypted_content: "encrypted" },
				{ role: "user", content: [{ type: "input_text", text: "recent" }] },
			],
		});
	});
});
