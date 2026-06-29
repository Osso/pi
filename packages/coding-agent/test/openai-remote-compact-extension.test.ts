import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCompactEndpoint,
	buildOpenAICompactPayload,
	buildOpenAIRequestHeaders,
	extractOpenAICompactDetails,
	handleSessionBeforeCompact,
	handleSessionCompactionSource,
	isOpenAIResponsesModel,
	OPENAI_REMOTE_COMPACTION_SUMMARY,
	type OpenAIRemoteCompactionDetails,
	rewriteOpenAICompactionPayload,
} from "../extensions/openai-remote-compact/src/index.ts";
import type { CompactionPreparation } from "../src/core/compaction/index.ts";
import type {
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactionSourceEvent,
} from "../src/core/extensions/types.ts";
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

function createOpenAICodexResponsesModel(
	overrides: Partial<Model<"openai-codex-responses">> = {},
): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		...overrides,
	};
}

function createCodexJwt(): string {
	return [
		"header",
		Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString(
			"base64url",
		),
		"signature",
	].join(".");
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

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("openai remote compact extension", () => {
	it("only handles first-party OpenAI Responses models", () => {
		expect(isOpenAIResponsesModel(createOpenAIResponsesModel())).toBe(true);
		expect(isOpenAIResponsesModel(createOpenAICodexResponsesModel())).toBe(true);
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

	it("drops function calls that have no matching tool output from compact payloads", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "use a tool", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-orphan|item-orphan", name: "read", arguments: { path: "missing" } },
				],
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		];

		const payload = buildOpenAICompactPayload(createOpenAICodexResponsesModel(), messages, "system prompt", []);

		expect(payload.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "use a tool" }] }]);
	});

	it("builds the Codex /responses/compact endpoint from the ChatGPT backend base URL", () => {
		expect(buildCompactEndpoint(createOpenAICodexResponsesModel())).toBe(
			"https://chatgpt.com/backend-api/codex/responses/compact",
		);
		expect(
			buildCompactEndpoint(createOpenAICodexResponsesModel({ baseUrl: "https://example.test/codex/responses" })),
		).toBe("https://example.test/codex/responses/compact");
	});

	it("adds Codex account headers for /responses/compact requests", () => {
		expect(
			buildOpenAIRequestHeaders(createOpenAICodexResponsesModel(), createCodexJwt(), { existing: "header" }),
		).toEqual({
			Authorization: `Bearer ${createCodexJwt()}`,
			"OpenAI-Beta": "responses=experimental",
			"chatgpt-account-id": "account-1",
			"content-type": "application/json",
			existing: "header",
			originator: "pi",
		});
	});

	it("extracts native replacement history from OpenAI /responses/compact output", () => {
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

	it("reports remote source before starting eligible OpenAI compaction", async () => {
		const model = createOpenAIResponsesModel();
		const event = {
			type: "session_compaction_source",
			reason: "manual",
			willRetry: false,
		} satisfies SessionCompactionSourceEvent;
		const ctx = {
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key", headers: undefined }),
			},
		} as unknown as ExtensionContext;

		const result = await handleSessionCompactionSource(event, ctx);

		expect(result?.source).toEqual({
			type: "openai_remote",
			provider: "openai",
			model: "gpt-4.1-mini",
			endpoint: "https://api.openai.com/v1/responses/compact",
		});
	});

	it("returns remote compaction duration from the compact endpoint call", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					output: [
						{ role: "user", content: [{ type: "input_text", text: "hello" }] },
						{ type: "compaction", encrypted_content: "encrypted" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as typeof fetch;
		const model = createOpenAIResponsesModel();
		const preparation: CompactionPreparation = {
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			firstKeptEntryId: "kept-1",
			isSplitTurn: false,
			messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
			settings: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 },
			tokensBefore: 1234,
			turnPrefixMessages: [],
		};
		const event = {
			type: "session_before_compact",
			preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		} satisfies SessionBeforeCompactEvent;
		const ctx = {
			model,
			getSystemPrompt: () => "system prompt",
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key", headers: undefined }),
			},
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;

		const result = await handleSessionBeforeCompact(event, ctx);

		expect(result?.compaction).toMatchObject({
			summary: OPENAI_REMOTE_COMPACTION_SUMMARY,
			firstKeptEntryId: "kept-1",
			tokensBefore: 1234,
			details: { type: "openai-remote-compaction" },
			source: {
				type: "openai_remote",
				provider: "openai",
				model: "gpt-4.1-mini",
				endpoint: "https://api.openai.com/v1/responses/compact",
			},
		});
		expect(result?.compaction?.durationMs).toEqual(expect.any(Number));
	});

	it("extracts native replacement history from Codex /responses/compact output", () => {
		const details = extractOpenAICompactDetails(
			createOpenAICodexResponsesModel(),
			{
				output: [
					{ role: "user", content: [{ type: "input_text", text: "hello" }] },
					{ type: "compaction_summary", encrypted_content: "encrypted" },
				],
			},
			"https://chatgpt.com/backend-api/codex/responses/compact",
		);

		expect(details.replacementHistory).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ type: "compaction_summary", encrypted_content: "encrypted" },
		]);
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
