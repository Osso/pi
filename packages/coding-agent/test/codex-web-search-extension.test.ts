import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexWebSearchExtension, {
	addWebSearchToolToPayload,
	createWebSearchToolDefinition,
	isOpenAIHostedWebSearchModel,
} from "../extensions/codex-web-search/src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

function model(api: "openai-responses" | "openai-codex-responses" | "anthropic-messages"): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai-codex",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

function context(api: Parameters<typeof model>[0]): ExtensionContext {
	return {
		model: model(api),
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
		},
	} as unknown as ExtensionContext;
}

describe("codex web search extension", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers a web_search tool without registering a CLI flag", () => {
		const registerFlag = vi.fn();
		const registerTool = vi.fn();

		codexWebSearchExtension({ registerFlag, registerTool } as unknown as ExtensionAPI);

		expect(registerFlag).not.toHaveBeenCalled();
		expect(registerTool).toHaveBeenCalledOnce();
		expect(registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "web_search",
				label: "Web Search",
				description: expect.stringContaining("Search the web"),
			}),
		);
	});

	it("executes web search with the current OpenAI Responses model", async () => {
		const runSearch = vi.fn(async () => "Search result text");
		const tool = createWebSearchToolDefinition({ runSearch });
		const ctx = context("openai-responses");

		const result = await tool.execute("call-1", { query: "pi web search" }, undefined, undefined, ctx);

		expect(runSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				query: "pi web search",
				model: ctx.model,
				apiKey: "test-key",
				signal: expect.any(AbortSignal),
			}),
			expect.anything(),
		);
		expect(result).toMatchObject({ content: [{ type: "text", text: "Search result text" }] });
	});

	it("times out slow hosted web search calls with a clear error", async () => {
		vi.useFakeTimers();
		let capturedSignal: AbortSignal | undefined;
		const runSearch = vi.fn((request: { signal?: AbortSignal }) => {
			capturedSignal = request.signal;
			return new Promise<string>(() => {});
		});
		const tool = createWebSearchToolDefinition({ runSearch, timeoutMs: 10 });

		const result = expect(
			tool.execute("call-1", { query: "slow search" }, undefined, undefined, context("openai-responses")),
		).rejects.toThrow("OpenAI hosted web_search timed out after 10ms");
		await vi.advanceTimersByTimeAsync(10);

		await result;
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("preserves caller aborts while applying the hosted search timeout", async () => {
		const controller = new AbortController();
		let capturedSignal: AbortSignal | undefined;
		const runSearch = vi.fn((request: { signal?: AbortSignal }) => {
			capturedSignal = request.signal;
			controller.abort(new Error("cancelled by user"));
			return new Promise<string>(() => {});
		});
		const tool = createWebSearchToolDefinition({ runSearch, timeoutMs: 10_000 });

		const result = expect(
			tool.execute("call-1", { query: "abort search" }, controller.signal, undefined, context("openai-responses")),
		).rejects.toThrow("cancelled by user");

		await result;
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("adds an SDK-compatible hosted web search tool to provider payloads", () => {
		expect(addWebSearchToolToPayload({ model: "gpt", tools: [{ type: "function", name: "read" }] })).toEqual({
			model: "gpt",
			tools: [{ type: "function", name: "read" }, { type: "web_search" }],
		});
		expect(addWebSearchToolToPayload({ model: "gpt", tools: [{ type: "web_search" }] })).toBeUndefined();
	});

	it("rejects web search when the current model cannot use hosted OpenAI search", async () => {
		const runSearch = vi.fn(async () => "Search result text");
		const tool = createWebSearchToolDefinition({ runSearch });

		await expect(
			tool.execute("call-1", { query: "pi web search" }, undefined, undefined, context("anthropic-messages")),
		).rejects.toThrow("web_search requires an OpenAI Responses model");
		expect(runSearch).not.toHaveBeenCalled();
	});

	it("identifies OpenAI Responses models as hosted web-search capable", () => {
		expect(isOpenAIHostedWebSearchModel(model("openai-responses"))).toBe(true);
		expect(isOpenAIHostedWebSearchModel(model("openai-codex-responses"))).toBe(true);
		expect(isOpenAIHostedWebSearchModel(model("anthropic-messages"))).toBe(false);
		expect(isOpenAIHostedWebSearchModel(undefined)).toBe(false);
	});
});
