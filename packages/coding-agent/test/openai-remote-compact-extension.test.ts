import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCompactEndpoint,
	buildOpenAICompactPayload,
	buildOpenAIRequestHeaders,
	extractOpenAICompactDetails,
	handleCompaction,
	isOpenAIResponsesModel,
	limitOpenAICompactInput,
	OPENAI_REMOTE_COMPACTION_SUMMARY,
} from "../extensions/openai-remote-compact/src/index.ts";
import type { CompactionPreparation } from "../src/core/compaction/index.ts";
import type { CompactionEvent, ExtensionContext } from "../src/core/extensions/types.ts";

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

	it("caps the /responses/compact input context to the first 400k serialized characters", () => {
		const tail = "tail that must not reach endpoint";
		const messages: AgentMessage[] = [{ role: "user", content: `${"a".repeat(450_000)}${tail}`, timestamp: 1 }];

		const payload = buildOpenAICompactPayload(createOpenAIResponsesModel(), messages, "system prompt", []);

		expect(JSON.stringify(payload.input).length).toBeLessThanOrEqual(400_000);
		expect(JSON.stringify(payload.input)).not.toContain(tail);
		expect(JSON.stringify(payload.input)).toContain(`"${"a".repeat(1000)}`);
		expect(payload.input[0]).toMatchObject({ role: "user" });
	});

	it("preserves parallel tool call order when compact input is under cap", () => {
		const input = [
			{ type: "function_call", id: "item-1", call_id: "call-1", name: "read", arguments: "{}" },
			{ type: "function_call", id: "item-2", call_id: "call-2", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call-1", output: "first" },
			{ type: "function_call_output", call_id: "call-2", output: "second" },
		];

		expect(limitOpenAICompactInput(input)).toEqual(input);
	});

	it("preserves function call arguments exactly when compact input is capped", () => {
		const toolArguments = { path: "large.txt", content: "keep arguments intact" };
		const messages: AgentMessage[] = [
			{ role: "user", content: `old ${"a".repeat(399_900)}`, timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1|item-1", name: "write", arguments: toolArguments }],
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
			{
				role: "toolResult",
				toolCallId: "call-1|item-1",
				toolName: "write",
				content: [{ type: "text", text: "wrote file" }],
				isError: false,
				timestamp: 3,
			},
		];

		const payload = buildOpenAICompactPayload(createOpenAICodexResponsesModel(), messages, "system prompt", []);
		const functionCall = payload.input.find((item) => item.type === "function_call");

		expect(JSON.stringify(payload.input).length).toBeLessThanOrEqual(400_000);
		expect(functionCall).toMatchObject({ arguments: JSON.stringify(toolArguments) });
	});

	it("truncates oversized text tool output while preserving its function call pair", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1|item-1", name: "read", arguments: { path: "large.txt" } }],
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
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-1|item-1",
				toolName: "read",
				content: [{ type: "text", text: `head ${"x".repeat(450_000)} tail` }],
				isError: false,
				timestamp: 2,
			},
		];

		const payload = buildOpenAICompactPayload(createOpenAICodexResponsesModel(), messages, "system prompt", []);
		const output = payload.input.find((item) => item.type === "function_call_output");

		expect(JSON.stringify(payload.input).length).toBeLessThanOrEqual(400_000);
		expect(payload.input.some((item) => item.type === "function_call")).toBe(true);
		expect(output).toMatchObject({ type: "function_call_output", call_id: "call-1" });
		expect(typeof output?.output).toBe("string");
		expect((output?.output as string).length).toBeGreaterThan(0);
		expect((output?.output as string).length).toBeLessThan(450_000);
	});

	it("drops oversized images instead of truncating image data", () => {
		const input = [
			{
				role: "user",
				content: [
					{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${"x".repeat(450_000)}` },
					{ type: "input_text", text: "keep this text" },
				],
			},
		];

		const limited = limitOpenAICompactInput(input);

		expect(limited).toEqual([{ role: "user", content: [{ type: "input_text", text: "keep this text" }] }]);
	});

	it("keeps older context before truncating the first chunk that overflows", () => {
		const input = [
			{ role: "user", content: [{ type: "input_text", text: `old ${"a".repeat(399_900)}` }] },
			{ role: "user", content: [{ type: "input_text", text: "newest text must remain" }] },
		];

		const limited = limitOpenAICompactInput(input);
		const serialized = JSON.stringify(limited);

		expect(serialized.length).toBeLessThanOrEqual(400_000);
		expect(serialized).toContain("newest text must remain");
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
			api: "openai-responses",
			model: "gpt-4.1-mini",
			endpoint: "https://api.openai.com/v1/responses/compact",
			replacementHistory: [
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "compaction", encrypted_content: "encrypted" },
			],
			replacementHistoryBytes: 120,
			replacementHistoryTokens: 30,
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
			type: "compaction",
			preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		} satisfies CompactionEvent;
		const ctx = {
			model,
			getSystemPrompt: () => "system prompt",
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key", headers: undefined }),
			},
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;

		const result = await handleCompaction(event, ctx);

		expect(result?.compaction).toMatchObject({
			summary: OPENAI_REMOTE_COMPACTION_SUMMARY,
			firstKeptEntryId: "kept-1",
			tokensBefore: 1234,
			compactedResultTokens: 30,
			details: { type: "openai-remote-compaction", api: "openai-responses", replacementHistoryTokens: 30 },
			source: {
				type: "openai_remote",
				provider: "openai",
				model: "gpt-4.1-mini",
				endpoint: "https://api.openai.com/v1/responses/compact",
			},
		});
		expect(result?.compaction?.durationMs).toEqual(expect.any(Number));
		expect(result?.compaction?.providerNative).toEqual({
			provider: "openai",
			api: "openai-responses",
			format: "openai.responses.input",
			value: [
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				{ type: "compaction", encrypted_content: "encrypted" },
			],
		});
	});

	it("does not prepend incompatible prior native replacement history", async () => {
		let requestPayload: unknown;
		globalThis.fetch = (async (_url, init) => {
			requestPayload = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{ role: "user", content: [{ type: "input_text", text: "new" }] },
						{ type: "compaction", encrypted_content: "new-encrypted" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const model = createOpenAIResponsesModel();
		const preparation: CompactionPreparation = {
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			firstKeptEntryId: "kept-1",
			isSplitTurn: false,
			messagesToSummarize: [{ role: "user", content: "new", timestamp: 1 }],
			settings: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 },
			tokensBefore: 1234,
			turnPrefixMessages: [],
		};
		const priorCodexCompaction = {
			type: "compaction" as const,
			id: "compact-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			summary: OPENAI_REMOTE_COMPACTION_SUMMARY,
			firstKeptEntryId: "kept-1",
			tokensBefore: 1000,
			details: {
				type: "openai-remote-compaction",
				version: 1,
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: "gpt-5.5",
				endpoint: "https://chatgpt.com/backend-api/codex/responses/compact",
				replacementHistory: [{ type: "compaction", encrypted_content: "old-codex" }],
				replacementHistoryBytes: 64,
				replacementHistoryTokens: 16,
			},
		};
		const event = {
			type: "compaction",
			preparation,
			branchEntries: [priorCodexCompaction],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		} satisfies CompactionEvent;
		const ctx = {
			model,
			getSystemPrompt: () => "system prompt",
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key", headers: undefined }),
			},
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;

		await handleCompaction(event, ctx);

		expect(requestPayload).toMatchObject({
			input: [{ role: "user", content: [{ type: "input_text", text: "new" }] }],
		});
		expect(JSON.stringify(requestPayload)).not.toContain("old-codex");
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
});
