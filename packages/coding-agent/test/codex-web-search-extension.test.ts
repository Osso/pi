import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexWebSearchExtension, {
	addAnthropicWebSearchToolToPayload,
	addWebSearchToolToPayload,
	createWebSearchToolDefinition,
	isOpenAIHostedWebSearchModel,
} from "../extensions/codex-web-search/src/index.ts";
import type {
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "../src/core/extensions/types.ts";

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

type BeforeProviderRequestHandler = ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>;

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
		const on = vi.fn();

		codexWebSearchExtension({ on, registerFlag, registerTool } as unknown as ExtensionAPI);

		expect(registerFlag).not.toHaveBeenCalled();
		expect(on).toHaveBeenCalledWith("before_provider_request", expect.any(Function));
		expect(registerTool).toHaveBeenCalledOnce();
		expect(registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "web_search",
				label: "Web Search",
				description: expect.stringContaining("Search the web"),
			}),
		);
	});

	it("injects hosted web search into OpenAI Responses provider payloads", () => {
		const on = vi.fn();
		codexWebSearchExtension({ on, registerTool: vi.fn() } as unknown as ExtensionAPI);
		const handler = on.mock.calls.find(([event]) => event === "before_provider_request")?.[1] as
			| BeforeProviderRequestHandler
			| undefined;

		expect(handler).toBeDefined();
		expect(
			handler?.(
				{
					type: "before_provider_request",
					payload: { tools: [{ type: "function", name: "web_search" }] },
					model: model("openai-responses"),
				},
				context("openai-responses"),
			),
		).toEqual({ tools: [{ type: "web_search", external_web_access: true }] });
		expect(
			handler?.(
				{
					type: "before_provider_request",
					payload: { tools: [{ name: "web_search", input_schema: {} }] },
					model: model("anthropic-messages"),
				},
				context("anthropic-messages"),
			),
		).toEqual({ tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] });
	});

	// A pool session's ctx.model is the pool; a Codex websocket opened without hosted web_search
	// rejects it on every later request, so the serving member decides.
	it("decides from the serving pool member, not the session's pool model", () => {
		const on = vi.fn();
		codexWebSearchExtension({ on, registerTool: vi.fn() } as unknown as ExtensionAPI);
		const handler = on.mock.calls.find(([event]) => event === "before_provider_request")?.[1] as
			| BeforeProviderRequestHandler
			| undefined;
		const poolContext = {
			model: { ...model("openai-codex-responses"), provider: "pool", id: "gpt-6.1-terra", api: "pool" },
		} as unknown as ExtensionContext;
		const payload = { model: "gpt-6.1-terra", tools: [{ type: "function", name: "read" }] };

		expect(
			handler?.({ type: "before_provider_request", payload, model: model("openai-codex-responses") }, poolContext),
		).toEqual({
			model: "gpt-6.1-terra",
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search", external_web_access: true },
			],
		});
		expect(
			handler?.({ type: "before_provider_request", payload, model: model("anthropic-messages") }, poolContext),
		).toEqual({
			model: "gpt-6.1-terra",
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search_20250305", name: "web_search", max_uses: 5 },
			],
		});
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

	it("keeps the authenticated model when the session model changes during authentication", async () => {
		const runSearch = vi.fn(async () => "Search result text");
		const tool = createWebSearchToolDefinition({ runSearch });
		const modelA = { ...model("openai-responses"), id: "model-a", baseUrl: "https://a.invalid/v1" };
		const modelB = { ...model("openai-responses"), id: "model-b", baseUrl: "https://b.invalid/v1" };
		let releaseAuth = () => {};
		const ctx = {
			model: modelA,
			modelRegistry: {
				getApiKeyAndHeaders: vi.fn(
					(requested: Model<Api>) =>
						new Promise((resolve) => {
							releaseAuth = () => resolve({ ok: true, apiKey: `key-for-${requested.id}` });
						}),
				),
			},
		} as unknown as ExtensionContext & { model: Model<Api> };

		const result = tool.execute("call-1", { query: "pi web search" }, undefined, undefined, ctx);
		await vi.waitFor(() => expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledOnce());
		ctx.model = modelB;
		releaseAuth();
		await result;

		expect(runSearch).toHaveBeenCalledWith(
			expect.objectContaining({ model: modelA, apiKey: "key-for-model-a" }),
			expect.anything(),
		);
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
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search", external_web_access: true },
			],
		});
		expect(addWebSearchToolToPayload({ model: "gpt", tools: [{ type: "web_search" }] })).toBeUndefined();
	});

	it("replaces the Pi web_search function tool with the hosted web search tool", () => {
		expect(
			addWebSearchToolToPayload({
				model: "gpt",
				tools: [
					{ type: "function", name: "web_search" },
					{ type: "function", name: "read" },
				],
			}),
		).toEqual({
			model: "gpt",
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search", external_web_access: true },
			],
		});
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

	it("replaces Pi's client web_search with Claude's server web search, keeping other tools", () => {
		expect(
			addAnthropicWebSearchToolToPayload({
				model: "claude-opus-5-5",
				tools: [
					{ name: "read", input_schema: {} },
					{ type: "custom", name: "web_search", input_schema: {} },
				],
			}),
		).toEqual({
			model: "claude-opus-5-5",
			tools: [
				{ name: "read", input_schema: {} },
				{ type: "web_search_20250305", name: "web_search", max_uses: 5 },
			],
		});
	});

	it("leaves an Anthropic payload that already has server web search unchanged", () => {
		const payload = { tools: [{ type: "web_search_20250305", name: "web_search" }] };
		expect(addAnthropicWebSearchToolToPayload(payload)).toBeUndefined();
	});
});
