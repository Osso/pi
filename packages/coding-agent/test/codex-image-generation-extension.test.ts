import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import codexImageGenerationExtension, {
	addImageGenerationToolToPayload,
	createImageGenerationToolDefinition,
	isOpenAIHostedImageGenerationModel,
} from "../extensions/codex-image-generation/src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

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

function context(api: Parameters<typeof model>[0]): ExtensionContext {
	return {
		model: model(api),
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "yes" } })),
		},
	} as unknown as ExtensionContext;
}

describe("Codex image generation extension", () => {
	it("registers image_gen without replacing it on the parent model request", () => {
		const on = vi.fn();
		const registerTool = vi.fn();
		codexImageGenerationExtension({ on, registerTool } as unknown as ExtensionAPI);

		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "image_gen" }));
		expect(on).not.toHaveBeenCalledWith("before_provider_request", expect.any(Function));
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
