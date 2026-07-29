import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 372000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-codex-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* createImageGenerationEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: { id: "ig_1", type: "image_generation_call", status: "in_progress", result: null },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: { id: "ig_1", type: "image_generation_call", status: "completed", result: "aW1hZ2U=" },
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_1", status: "completed" },
	} as ResponseStreamEvent;
}

describe("OpenAI Responses image generation", () => {
	it("emits completed image generation output as image content", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createImageGenerationEvents(), output, stream, model);

		expect(output.imageGenerationResult).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
	});

	it("captures Codex image data from a partial-image event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				sequence_number: 8,
				output_index: 1,
				item: { id: "ig_live", type: "image_generation_call", status: "in_progress" },
			} as ResponseStreamEvent;
			yield {
				type: "response.image_generation_call.partial_image",
				background: "opaque",
				item_id: "ig_live",
				output_format: "png",
				output_index: 1,
				partial_image_b64: "bGl2ZS1pbWFnZQ==",
				partial_image_index: 0,
				quality: "medium",
				sequence_number: 11,
				size: "1024x1024",
			} as ResponseStreamEvent;
			yield {
				type: "response.completed",
				sequence_number: 12,
				response: { id: "resp_live", status: "completed" },
			} as ResponseStreamEvent;
		}

		await processResponsesStream(events(), output, stream, model);

		expect(output.imageGenerationResult).toEqual({
			type: "image",
			data: "bGl2ZS1pbWFnZQ==",
			mimeType: "image/png",
		});
	});

	it("extracts image generation output from the terminal response", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.completed",
				sequence_number: 0,
				response: {
					id: "resp_terminal_image",
					status: "completed",
					output: [
						{ id: "ig_terminal", type: "image_generation_call", status: "completed", result: "dGVybWluYWw=" },
					],
				},
			} as ResponseStreamEvent;
		}

		await processResponsesStream(events(), output, stream, model);

		expect(output.imageGenerationResult).toEqual({
			type: "image",
			data: "dGVybWluYWw=",
			mimeType: "image/png",
		});
	});

	it("ignores failed image generation output without image data", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.output_item.done",
				sequence_number: 0,
				output_index: 0,
				item: { id: "ig_failed", type: "image_generation_call", status: "failed", result: null },
			} as ResponseStreamEvent;
			yield {
				type: "response.completed",
				sequence_number: 1,
				response: { id: "resp_failed", status: "completed" },
			} as ResponseStreamEvent;
		}

		await processResponsesStream(events(), output, stream, model);

		expect(output.imageGenerationResult).toBeUndefined();
		expect(pushSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "image_end" }));
	});
});
