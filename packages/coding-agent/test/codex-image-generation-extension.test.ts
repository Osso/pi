import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import codexImageGenerationExtension, {
	addImageGenerationToolToPayload,
	createImageGenerationToolDefinition,
	isOpenAIHostedImageGenerationModel,
} from "../extensions/codex-image-generation/src/index.ts";
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
		input: ["text", "image"],
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
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "yes" } })),
		},
	} as unknown as ExtensionContext;
}

describe("Codex image generation extension", () => {
	it("registers image_gen and injects the hosted tool for OpenAI Responses models", () => {
		const on = vi.fn();
		const registerTool = vi.fn();
		codexImageGenerationExtension({ on, registerTool } as unknown as ExtensionAPI);
		const handler = on.mock.calls.find(([event]) => event === "before_provider_request")?.[1] as
			| BeforeProviderRequestHandler
			| undefined;

		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "image_gen" }));
		expect(
			handler?.(
				{
					type: "before_provider_request",
					payload: { tools: [{ type: "function", name: "image_gen" }] },
				},
				context("openai-codex-responses"),
			),
		).toEqual({ tools: [{ type: "image_generation" }] });
		expect(
			handler?.({ type: "before_provider_request", payload: { tools: [] } }, context("anthropic-messages")),
		).toBeUndefined();
	});

	it("executes hosted image generation with current Codex authentication", async () => {
		const runGeneration = vi.fn(async () => ({ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }));
		const tool = createImageGenerationToolDefinition({ runGeneration });
		const ctx = context("openai-codex-responses");

		const result = await tool.execute("call-1", { prompt: "A simple blue circle" }, undefined, undefined, ctx);

		expect(runGeneration).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "A simple blue circle",
				model: ctx.model,
				apiKey: "test-key",
				headers: { "x-test": "yes" },
				signal: expect.any(AbortSignal),
			}),
			ctx,
		);
		expect(result.content).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
	});

	it("adds one hosted image tool and removes the same-named function tool", () => {
		expect(
			addImageGenerationToolToPayload({
				model: "gpt",
				tools: [
					{ type: "function", name: "image_gen" },
					{ type: "function", name: "read" },
				],
			}),
		).toEqual({
			model: "gpt",
			tools: [{ type: "function", name: "read" }, { type: "image_generation" }],
		});
		expect(addImageGenerationToolToPayload({ tools: [{ type: "image_generation" }] })).toBeUndefined();
	});

	it("identifies OpenAI Responses models as hosted image-generation capable", () => {
		expect(isOpenAIHostedImageGenerationModel(model("openai-responses"))).toBe(true);
		expect(isOpenAIHostedImageGenerationModel(model("openai-codex-responses"))).toBe(true);
		expect(isOpenAIHostedImageGenerationModel(model("anthropic-messages"))).toBe(false);
	});
});
