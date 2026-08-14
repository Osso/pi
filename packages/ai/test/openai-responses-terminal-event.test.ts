import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

vi.mock("openai", () => {
	async function* createMockResponsesStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_wrapper_early_eof" },
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "reasoning", id: "rs_wrapper_early_eof", summary: [] },
		} as ResponseStreamEvent;
		yield {
			type: "response.reasoning_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			item_id: "rs_wrapper_early_eof",
			delta: "partial reasoning before the wrapper stream ends",
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createMockResponsesStream();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
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

async function* createEarlyEofEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		sequence_number: 0,
		response: { id: "resp_early_eof" },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 0,
		item: { type: "reasoning", id: "rs_early_eof", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		sequence_number: 2,
		output_index: 0,
		content_index: 0,
		item_id: "rs_early_eof",
		delta: "partial reasoning before the stream ends",
	} as ResponseStreamEvent;
}

async function* createCompletedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_completed",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createIncompleteEvents(
	reason: "max_output_tokens" | "content_filter" = "max_output_tokens",
): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.incomplete",
		sequence_number: 0,
		response: {
			id: "resp_incomplete",
			status: "incomplete",
			incomplete_details: { reason },
			usage: {
				input_tokens: 30,
				output_tokens: 12,
				total_tokens: 42,
				input_tokens_details: { cached_tokens: 5 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createFailedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.failed",
		sequence_number: 0,
		response: {
			id: "resp_failed",
			status: "failed",
			error: { code: "server_error", message: "boom" },
		},
	} as ResponseStreamEvent;
}

const RAW_CITATION_MARKER = "citeturn2search1";

interface TextEventOptions {
	text: string;
	deltas: string[];
	withWebSearchCall?: boolean;
}

interface ResponseTextResult {
	streamedText: string;
	finalText: string;
}

async function* createTextEvents(options: TextEventOptions): AsyncIterable<ResponseStreamEvent> {
	let sequenceNumber = 0;
	const messageOutputIndex = options.withWebSearchCall === false ? 0 : 1;

	if (options.withWebSearchCall !== false) {
		yield {
			type: "response.output_item.added",
			sequence_number: sequenceNumber++,
			output_index: 0,
			item: {
				type: "web_search_call",
				id: "ws_citation",
				status: "completed",
				action: { type: "search", query: "citation test" },
			},
		} as ResponseStreamEvent;
	}

	yield {
		type: "response.output_item.added",
		sequence_number: sequenceNumber++,
		output_index: messageOutputIndex,
		item: { type: "message", id: "msg_citation", role: "assistant", status: "in_progress", content: [] },
	} as ResponseStreamEvent;

	for (const delta of options.deltas) {
		yield {
			type: "response.output_text.delta",
			sequence_number: sequenceNumber++,
			output_index: messageOutputIndex,
			content_index: 0,
			item_id: "msg_citation",
			delta,
		} as ResponseStreamEvent;
	}

	yield {
		type: "response.output_item.done",
		sequence_number: sequenceNumber++,
		output_index: messageOutputIndex,
		item: {
			type: "message",
			id: "msg_citation",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: options.text, annotations: [] }],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: sequenceNumber,
		response: { id: "resp_citation", status: "completed" },
	} as ResponseStreamEvent;
}

async function collectResponseText(events: AsyncIterable<ResponseStreamEvent>): Promise<ResponseTextResult> {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	const streamedEvents: AssistantMessageEvent[] = [];
	const consumeEvents = (async () => {
		for await (const event of stream) streamedEvents.push(event);
	})();

	await processResponsesStream(events, output, stream, model);
	stream.end();
	await consumeEvents;

	const textBlock = output.content.find((content) => content.type === "text");
	if (!textBlock || textBlock.type !== "text") throw new Error("Expected a text response");

	return {
		streamedText: streamedEvents
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta)
			.join(""),
		finalText: textBlock.text,
	};
}

describe("OpenAI Responses terminal event handling", () => {
	it("rejects streams that end before a terminal response event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createEarlyEofEvents(), output, stream, model)).rejects.toThrow(
			"OpenAI Responses stream ended before a terminal response event",
		);
	});

	it("emits an error final result when the wrapper stream ends before a terminal response event", async () => {
		const model = createModel();
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
			tools: [],
		};
		const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];

		for await (const event of stream) {
			events.push(event);
		}

		const result = await stream.result();
		const lastEvent = events.at(-1);
		expect(lastEvent?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI Responses stream ended before a terminal response event");
	});

	it("finalizes completed terminal events as stop", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCompletedEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_completed");
		expect(output.stopReason).toBe("stop");
		expect(output.usage).toMatchObject({
			input: 18,
			output: 7,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 27,
		});
	});

	it("finalizes max-output incomplete terminal events as length with terminal metadata", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createIncompleteEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.errorMessage).toBeUndefined();
		expect(output.usage).toMatchObject({
			input: 25,
			output: 12,
			cacheRead: 5,
			totalTokens: 42,
		});
	});

	it("rejects content-filter incomplete terminal events with a clear reason", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(
			processResponsesStream(createIncompleteEvents("content_filter"), output, stream, model),
		).rejects.toThrow("Incomplete response returned, reason: content_filter");
	});

	it("rejects failed terminal events with the provider error", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createFailedEvents(), output, stream, model)).rejects.toThrow(
			"server_error: boom",
		);
	});

	it("removes a raw hosted-search citation marker from streamed and finalized text", async () => {
		const readableText =
			"Niri’s cursor setting also establishes XCURSOR_THEME and XCURSOR_SIZE for launched applications.";
		const rawText = `${readableText} ${RAW_CITATION_MARKER}`;
		const result = await collectResponseText(
			createTextEvents({
				text: rawText,
				deltas: [`${readableText} `, "citeturn2search", "1"],
			}),
		);

		expect(result.streamedText).toBe(readableText);
		expect(result.finalText).toBe(readableText);
	});

	it("removes a valid citation marker without a hosted-search event", async () => {
		const readableText = "External web-search response.";
		const rawText = `${readableText} ${RAW_CITATION_MARKER}`;
		const result = await collectResponseText(
			createTextEvents({
				text: rawText,
				deltas: [rawText],
				withWebSearchCall: false,
			}),
		);

		expect(result.streamedText).toBe(readableText);
		expect(result.finalText).toBe(readableText);
	});

	it("removes a citation marker split at every delta boundary", async () => {
		const expectedText = "Before after.";
		for (let splitIndex = 1; splitIndex < RAW_CITATION_MARKER.length; splitIndex++) {
			const result = await collectResponseText(
				createTextEvents({
					text: `Before ${RAW_CITATION_MARKER} after.`,
					deltas: [
						`Before ${RAW_CITATION_MARKER.slice(0, splitIndex)}`,
						`${RAW_CITATION_MARKER.slice(splitIndex)} after.`,
					],
				}),
			);

			expect(result.streamedText, `stream split at ${splitIndex}`).toBe(expectedText);
			expect(result.finalText, `final split at ${splitIndex}`).toBe(expectedText);
		}
	});

	it("preserves readable spacing around multiple and adjacent citation markers", async () => {
		const rawText = `One.${RAW_CITATION_MARKER}${RAW_CITATION_MARKER}Two, ${RAW_CITATION_MARKER}three${RAW_CITATION_MARKER}four.`;
		const result = await collectResponseText(createTextEvents({ text: rawText, deltas: [rawText] }));

		expect(result.streamedText).toBe("One. Two, three four.");
		expect(result.finalText).toBe("One. Two, three four.");
	});

	it("preserves incomplete, malformed, and unrelated marker text", async () => {
		const cases: Array<TextEventOptions & { name: string }> = [
			{
				name: "incomplete citation",
				text: "Keep citeturn2search1",
				deltas: ["Keep citeturn2", "search1"],
			},
			{
				name: "malformed citation payload",
				text: "Keep citenot-a-turn",
				deltas: ["Keep citenot-a-turn"],
			},
			{
				name: "URL citation payload",
				text: "Keep citehttps://example.com",
				deltas: ["Keep citehttps://example.com"],
			},
			{
				name: "unrelated annotation",
				text: "Keep noteturn2search1",
				deltas: ["Keep noteturn2search1"],
			},
		];

		for (const testCase of cases) {
			const result = await collectResponseText(createTextEvents(testCase));
			expect(result.streamedText, `${testCase.name} streamed text`).toBe(testCase.text);
			expect(result.finalText, `${testCase.name} final text`).toBe(testCase.text);
		}
	});
});
