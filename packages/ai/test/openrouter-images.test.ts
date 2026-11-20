import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastRequestOptions: undefined as unknown,
	response: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown, requestOptions?: unknown) => {
					mockState.lastParams = params;
					mockState.lastRequestOptions = requestOptions;
					const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal;
					if (signal?.aborted) {
						const error = new Error("Request aborted");
						return {
							withResponse: async () => {
								throw error;
							},
						};
					}
					const response = (mockState.response as undefined) ?? {
						id: "img-1",
						usage: {
							prompt_tokens: 12,
							completion_tokens: 34,
							prompt_tokens_details: { cached_tokens: 0 },
						},
						choices: [
							{
								message: {
									content: "Here is your image.",
									images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }],
								},
							},
						],
					};
					const promise = Promise.resolve(response) as Promise<typeof response> & {
						withResponse: () => Promise<{
							data: typeof response;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: response,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openrouter images", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastRequestOptions = undefined;
		mockState.response = undefined;
	});

	it("returns text plus images in final output", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "google/gemini-3.1-flash-image-preview",
			name: "Gemini 3.1 Flash Image Preview",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["text", "image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
			headers: { "HTTP-Referer": "https://example.com" },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.stopReason).toBe("stop");
		expect(output.responseId).toBe("img-1");
		expect(output.output[0]).toMatchObject({ type: "text", text: "Here is your image." });
		expect(output.output[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "ZmFrZS1wbmc=" });

		const params = mockState.lastParams as {
			stream?: boolean;
			modalities?: string[];
			messages?: [{ content?: [{ type: string; text?: string }] }];
		};
		expect(params.stream).toBe(false);
		expect(params.modalities).toEqual(["image", "text"]);
		expect(params.messages?.[0]?.content?.[0]).toMatchObject({ type: "text", text: "Generate a dog" });
	});

	it("passes through abort signal and returns aborted result", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};
		const controller = new AbortController();
		controller.abort();

		const output = await generateImages(model, context, { apiKey: "test", signal: controller.signal });
		expect(output.stopReason).toBe("aborted");
		expect(output.errorMessage).toBe("Request aborted");
		expect(mockState.lastRequestOptions).toMatchObject({ signal: controller.signal });
	});

	it("generateImages resolves the final assistant images result", async () => {
		const model: ImagesModel<"openrouter-images"> = {
			id: "black-forest-labs/flux.2-pro",
			name: "FLUX.2 Pro",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
			output: ["image"],
			cost: { input: 0.015, output: 0.03, cacheRead: 0, cacheWrite: 0 },
		};
		const context: ImagesContext = {
			input: [{ type: "text", text: "Generate a dog" }],
		};

		const output = await generateImages(model, context, { apiKey: "test" });
		expect(output.output.some((item) => item.type === "image")).toBe(true);
	});

	const gptImageModel: ImagesModel<"openrouter-images"> = {
		id: "openai/gpt-5-image",
		name: "GPT-5 Image",
		api: "openrouter-images",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 10, output: 10, cacheRead: 1, cacheWrite: 1 },
	};
	const prompt: ImagesContext = { input: [{ type: "text", text: "Generate a dog" }] };

	it("reports a content-filtered response as an error", async () => {
		mockState.response = {
			id: "img-filtered",
			choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: null } }],
		};

		const result = await generateImages(gptImageModel, prompt, { apiKey: "test" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content_filter");
		expect(result.output).toEqual([]);
	});

	it("keeps cached_tokens as cache reads when cache writes are reported", async () => {
		mockState.response = {
			id: "img-cache",
			usage: {
				prompt_tokens: 100,
				completion_tokens: 5,
				total_tokens: 105,
				prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
			},
			choices: [{ message: { content: null, images: [{ image_url: "data:image/png;base64,ZmFrZS1wbmc=" }] } }],
		};

		const result = await generateImages(gptImageModel, prompt, { apiKey: "test" });

		expect(result.usage).toMatchObject({ input: 20, cacheRead: 50, cacheWrite: 30, output: 5, totalTokens: 105 });
	});
});
