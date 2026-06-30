import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import codexWebSearchExtension, {
	addWebSearchToolToPayload,
	handleBeforeProviderRequest,
	resolveWebSearchMode,
} from "../extensions/codex-web-search/src/index.ts";
import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

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
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
}

describe("codex web search extension", () => {
	it("registers a web-search CLI flag and provider payload hook", () => {
		const registerFlag = vi.fn();
		const on = vi.fn();
		const getFlag = vi.fn(() => "disabled");

		codexWebSearchExtension({ registerFlag, on, getFlag } as unknown as ExtensionAPI);

		expect(registerFlag).toHaveBeenCalledWith("web-search", {
			description: "Enable OpenAI Responses hosted web search: disabled, cached, or live",
			type: "string",
			default: "disabled",
		});
		expect(on).toHaveBeenCalledWith("before_provider_request", expect.any(Function));
	});

	it("maps live and cached modes to external_web_access", () => {
		expect(addWebSearchToolToPayload({ model: "gpt", tools: [] }, "live")).toMatchObject({
			tools: [{ type: "web_search", external_web_access: true }],
		});
		expect(addWebSearchToolToPayload({ model: "gpt", tools: [] }, "cached")).toMatchObject({
			tools: [{ type: "web_search", external_web_access: false }],
		});
	});

	it("preserves existing tools and avoids duplicate hosted web search tools", () => {
		const payload = {
			model: "gpt",
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search", external_web_access: false },
			],
		};

		expect(addWebSearchToolToPayload(payload, "live")).toBeUndefined();
		expect(addWebSearchToolToPayload({ model: "gpt", tools: [{ type: "function", name: "read" }] }, "live")).toEqual({
			model: "gpt",
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search", external_web_access: true },
			],
		});
	});

	it("only rewrites OpenAI Responses payloads when the flag enables web search", () => {
		const event: BeforeProviderRequestEvent = { type: "before_provider_request", payload: { model: "gpt" } };

		expect(handleBeforeProviderRequest(event, context("openai-responses"), "live")).toEqual({
			model: "gpt",
			tools: [{ type: "web_search", external_web_access: true }],
		});
		expect(handleBeforeProviderRequest(event, context("openai-codex-responses"), "cached")).toEqual({
			model: "gpt",
			tools: [{ type: "web_search", external_web_access: false }],
		});
		expect(handleBeforeProviderRequest(event, context("openai-responses"), "disabled")).toBeUndefined();
		expect(handleBeforeProviderRequest(event, context("anthropic-messages"), "live")).toBeUndefined();
	});

	it("validates flag values", () => {
		expect(resolveWebSearchMode("live")).toBe("live");
		expect(resolveWebSearchMode("cached")).toBe("cached");
		expect(resolveWebSearchMode("disabled")).toBe("disabled");
		expect(resolveWebSearchMode(undefined)).toBe("disabled");
		expect(resolveWebSearchMode(true)).toBe("live");
		expect(resolveWebSearchMode("invalid")).toBeUndefined();
	});
});
