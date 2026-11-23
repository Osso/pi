import { beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({ streamEvents: undefined as unknown[] | undefined }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			if (bedrockMock.streamEvents) {
				const events = bedrockMock.streamEvents;
				return Promise.resolve({
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield* events;
					})(),
				});
			}
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "global.openai.gpt-5.6-terra",
	name: "GPT-5.6 Terra (Global)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

beforeEach(() => {
	bedrockMock.streamEvents = undefined;
});

describe("Bedrock unhandled stop reasons", () => {
	it.each(["content_filtered", "guardrail_intervened"])("reports %s in the error message", async (stopReason) => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
			{ messageStop: { stopReason } },
		];

		const result = await streamBedrock(model, context, { cacheRetention: "none", region: "ap-northeast-1" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(`Provider stopped with: ${stopReason}`);
	});
});
