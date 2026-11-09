import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertPiMessages } from "../extensions/claude-bridge/src/convert.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Claude bridge message conversion", () => {
	it("preserves user and tool-result images in Claude session content blocks", () => {
		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Inspect this image" },
					{ type: "image", data: "dXNlci1pbWFnZQ==", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "image.png" } }],
				api: "openai-responses",
				provider: "openai-codex",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [
					{ type: "text", text: "Image dimensions: 1x1" },
					{ type: "image", data: "dG9vbC1pbWFnZQ==", mimeType: "image/jpeg" },
				],
				isError: false,
				timestamp: 3,
			},
		] satisfies PiMessage[];

		const { anthropicMessages } = convertPiMessages(messages);

		expect(anthropicMessages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Inspect this image" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "dXNlci1pbWFnZQ==" } },
				],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "image.png" } }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: [
							{ type: "text", text: "Image dimensions: 1x1" },
							{
								type: "image",
								source: { type: "base64", media_type: "image/jpeg", data: "dG9vbC1pbWFnZQ==" },
							},
						],
						is_error: false,
					},
				],
			},
		]);
	});
});
