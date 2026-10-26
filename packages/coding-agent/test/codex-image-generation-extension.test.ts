import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import codexImageGenerationExtension, {
	addImageGenerationToolToPayload,
	createImageGenerationToolDefinition,
	isOpenAIHostedImageGenerationModel,
} from "../extensions/codex-image-generation/src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type TestApi = "openai-responses" | "openai-codex-responses" | "anthropic-messages";

function model(api: TestApi, provider?: string, id = "test-model"): Model<Api> {
	return {
		id,
		name: "Test Model",
		api,
		provider: provider ?? (api === "anthropic-messages" ? "anthropic" : "openai-codex"),
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

function context(api: TestApi, provider?: string): ExtensionContext {
	return {
		model: model(api, provider),
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "yes" } })),
		},
	} as unknown as ExtensionContext;
}

describe("Codex image generation extension", () => {
	it("registers image_gen without rewriting main-session provider requests", () => {
		const on = vi.fn();
		const registerTool = vi.fn();

		codexImageGenerationExtension({ on, registerTool } as unknown as ExtensionAPI);

		expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "image_gen" }));
		expect(on).not.toHaveBeenCalled();
	});

	it.each(["openai-codex", "openai-codex-gc", "openai-codex-team"])(
		"saves generated PNG using %s auth and returns its path with the image",
		async (provider) => {
			const outputDirectory = mkdtempSync(join(tmpdir(), "pi-image-gen-test-"));
			try {
				const runGeneration = vi.fn(async () => ({
					type: "image" as const,
					data: "aW1hZ2U=",
					mimeType: "image/png",
				}));
				const tool = createImageGenerationToolDefinition({ runGeneration });
				const ctx = { ...context("openai-codex-responses", provider), cwd: outputDirectory } as ExtensionContext;

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
				const pathText = result.content.find((entry) => entry.type === "text")?.text;
				const savedPath = pathText?.replace("Generated image: ", "");
				expect(savedPath).toMatch(new RegExp(`^${outputDirectory}/image-gen-[a-f0-9]{16}\\.png$`));
				expect(readFileSync(savedPath ?? "")).toEqual(Buffer.from("image"));
				expect(result.content).toContainEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
			} finally {
				rmSync(outputDirectory, { recursive: true, force: true });
			}
		},
	);

	it("uses the configured default Codex model when the session model is not Codex", async () => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "pi-image-gen-test-"));
		try {
			const personal = model("openai-codex-responses", "openai-codex", "gpt-6.1-sol");
			const teamOld = model("openai-codex-responses", "openai-codex-team", "gpt-5.5");
			const teamDefault = model("openai-codex-responses", "openai-codex-team", "gpt-6.1-sol");
			const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "team-key", headers: {} }));
			const ctx = {
				cwd: outputDirectory,
				model: model("anthropic-messages"),
				modelRegistry: {
					getAvailable: () => [model("anthropic-messages"), personal, teamOld, teamDefault],
					getApiKeyAndHeaders,
				},
				settingsManager: {
					getDefaultProvider: () => "openai-codex-team",
					getDefaultModel: () => "gpt-6.1-sol",
					getEnabledModels: () => ["openai-codex/gpt-6.1-sol"],
				},
			} as unknown as ExtensionContext;
			const runGeneration = vi.fn(async () => ({ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }));
			const tool = createImageGenerationToolDefinition({ runGeneration });

			await tool.execute("call-1", { prompt: "A simple blue circle" }, undefined, undefined, ctx);

			expect(getApiKeyAndHeaders).toHaveBeenCalledWith(teamDefault);
			expect(runGeneration).toHaveBeenCalledWith(
				expect.objectContaining({ model: teamDefault, apiKey: "team-key" }),
				ctx,
			);
		} finally {
			rmSync(outputDirectory, { recursive: true, force: true });
		}
	});

	it("uses the first enabled Codex model when the default model is not Codex", async () => {
		const gcOld = model("openai-codex-responses", "openai-codex-gc", "gpt-5.5");
		const gcEnabled = model("openai-codex-responses", "openai-codex-gc", "gpt-6-astra");
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "gc-key", headers: {} }));
		const ctx = {
			cwd: tmpdir(),
			model: model("anthropic-messages"),
			modelRegistry: { getAvailable: () => [model("anthropic-messages"), gcOld, gcEnabled], getApiKeyAndHeaders },
			settingsManager: {
				getDefaultProvider: () => "anthropic",
				getDefaultModel: () => "claude-opus-5-5",
				getEnabledModels: () => ["anthropic/claude-opus-5-5", "openai-codex-gc/gpt-6-astra"],
			},
		} as unknown as ExtensionContext;
		const runGeneration = vi.fn(async () => {
			throw new Error("stop after auth");
		});
		const tool = createImageGenerationToolDefinition({ runGeneration });

		await expect(tool.execute("call-1", { prompt: "x" }, undefined, undefined, ctx)).rejects.toThrow(
			"stop after auth",
		);
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(gcEnabled);
	});

	it("fails with a hint when no configured Codex model is logged in", async () => {
		const ctx = {
			cwd: tmpdir(),
			model: model("anthropic-messages"),
			modelRegistry: { getAvailable: () => [model("anthropic-messages")], getApiKeyAndHeaders: vi.fn() },
		} as unknown as ExtensionContext;
		const tool = createImageGenerationToolDefinition({ runGeneration: vi.fn() });

		await expect(tool.execute("call-1", { prompt: "x" }, undefined, undefined, ctx)).rejects.toThrow(
			"image_gen needs a logged-in Codex model as defaultModel or in enabledModels (pi login openai-codex)",
		);
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
			tools: [
				{ type: "function", name: "read" },
				{ type: "image_generation", output_format: "png" },
			],
		});
		expect(
			addImageGenerationToolToPayload({ tools: [{ type: "image_generation", output_format: "png" }] }),
		).toBeUndefined();
	});

	it("identifies only Codex provider models as hosted image-generation capable", () => {
		expect(isOpenAIHostedImageGenerationModel(model("openai-codex-responses", "openai-codex"))).toBe(true);
		expect(isOpenAIHostedImageGenerationModel(model("openai-codex-responses", "openai-codex-gc"))).toBe(true);
		expect(isOpenAIHostedImageGenerationModel(model("openai-codex-responses", "openai-codex-team"))).toBe(true);
		expect(isOpenAIHostedImageGenerationModel(model("openai-responses", "openai"))).toBe(false);
		expect(isOpenAIHostedImageGenerationModel(model("anthropic-messages", "anthropic"))).toBe(false);
	});
});
