import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessageEventStream, Context, Model } from "../src/types.ts";

const context: Context = {
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

async function captureMaxOutputTokens(
	start: (onPayload: (payload: unknown) => void) => AssistantMessageEventStream,
): Promise<unknown> {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	let payload: { max_output_tokens?: unknown } | undefined;
	for await (const event of start((p) => {
		payload = p as { max_output_tokens?: unknown };
	})) {
		if (event.type === "done" || event.type === "error") break;
	}
	return payload?.max_output_tokens;
}

const azureModel: Model<"azure-openai-responses"> = {
	...getModel("openai", "gpt-5.4"),
	api: "azure-openai-responses",
	provider: "custom-azure",
	compat: undefined,
};

function openAI(maxTokens: number) {
	return captureMaxOutputTokens((onPayload) =>
		streamOpenAIResponses(getModel("openai", "gpt-5.4"), context, { apiKey: "test-key", maxTokens, onPayload }),
	);
}

function azure(maxTokens: number) {
	return captureMaxOutputTokens((onPayload) =>
		streamAzureOpenAIResponses(azureModel, context, {
			apiKey: "test-key",
			azureBaseUrl: "https://example.openai.azure.com/openai/v1",
			maxTokens,
			onPayload,
		}),
	);
}

describe("OpenAI Responses max_output_tokens floor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["openai", openAI],
		["azure", azure],
	] as const)("%s raises max_output_tokens below 16 to 16 and keeps larger values", async (_name, capture) => {
		expect(await capture(1)).toBe(16);
		expect(await capture(15)).toBe(16);
		expect(await capture(4096)).toBe(4096);
	});
});
