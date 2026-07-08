import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model, ToolResultMessage } from "../src/types.ts";

interface AnthropicPayload {
	messages: Array<{
		content: Array<{ type: string; tool_use_id?: string }> | string;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5",
		name: "Claude Fable 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true },
	};
}

async function capturePayload(context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamAnthropic(makeAnthropicModel(), context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

function findToolResultId(payload: AnthropicPayload): string | undefined {
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		const toolResult = message.content.find((block) => block.type === "tool_result");
		if (toolResult) return toolResult.tool_use_id;
	}
	return undefined;
}

describe("Anthropic tool call ID normalization", () => {
	it("normalizes orphan tool result IDs before building Anthropic payloads", async () => {
		const orphanToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_123|fc_123",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
		};

		const payload = await capturePayload({ messages: [orphanToolResult] });

		expect(findToolResultId(payload)).toBe("call_123_fc_123");
	});
});
