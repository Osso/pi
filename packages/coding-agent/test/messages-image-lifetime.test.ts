import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";

const firstImage: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
};
const secondImage: ImageContent = {
	...firstImage,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
};
const roles = ["user", "custom", "toolResult"] as const;

function imageMessage(
	role: (typeof roles)[number],
	content: ImageContent = firstImage,
): Extract<AgentMessage, { role: (typeof roles)[number] }> & { content: (TextContent | ImageContent)[] } {
	const messageContent: (TextContent | ImageContent)[] = [
		{ type: "text", text: "Before screenshot" },
		{ ...content },
		{ type: "text", text: "After screenshot" },
	];
	if (role === "custom") {
		return { role, customType: "screenshot", content: messageContent, display: true, timestamp: 1 };
	}
	if (role === "toolResult") {
		return { role, toolName: "read", toolCallId: "capture-1", content: messageContent, isError: false, timestamp: 1 };
	}
	return { role, content: messageContent, timestamp: 1 };
}

describe("convertToLlm image lifetime", () => {
	it("preserves distinct screenshots across later image reads and unrelated tool calls", async () => {
		const faux = registerFauxProvider({ models: [{ id: "tool-image-lifetime", input: ["text", "image"] }] });
		const requests: Message[][] = [];
		const responses = [
			fauxAssistantMessage(fauxToolCall("read_first", {}, { id: "read-first" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read_second", {}, { id: "read-second" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("continue_work", {}, { id: "continue-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished using both screenshot observations"),
		];
		faux.setResponses(
			responses.map((response) => (context: Context) => {
				requests.push(structuredClone(context.messages));
				return response;
			}),
		);
		try {
			const agent = new Agent({
				initialState: {
					model: faux.getModel(),
					tools: [
						{
							name: "read_first",
							label: "Read first",
							description: "Read first screenshot",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ ...firstImage }], details: {} }),
						},
						{
							name: "read_second",
							label: "Read second",
							description: "Read second screenshot",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ ...secondImage }], details: {} }),
						},
						{
							name: "continue_work",
							label: "Continue",
							description: "Continue work",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text" as const, text: "Continued" }], details: {} }),
						},
					],
				},
				convertToLlm,
				getApiKey: () => "faux-key",
			});
			await agent.prompt("Read both screenshots and continue work");
			expect(requests).toHaveLength(4);
			for (const request of requests.slice(2)) {
				expect(
					request.find((message) => message.role === "toolResult" && message.toolCallId === "read-first")?.content,
				).toContainEqual(firstImage);
				expect(
					request.find((message) => message.role === "toolResult" && message.toolCallId === "read-second")
						?.content,
				).toContainEqual(secondImage);
			}
			const savedResults = agent.state.messages.filter((message) => message.role === "toolResult");
			expect(
				savedResults.find((message) => message.role === "toolResult" && message.toolCallId === "read-first")
					?.content,
			).toContainEqual(firstImage);
			expect(
				savedResults.find((message) => message.role === "toolResult" && message.toolCallId === "read-second")
					?.content,
			).toContainEqual(secondImage);
		} finally {
			faux.unregister();
		}
	});

	for (const role of roles) {
		it.each(["stop", "toolUse", "length", "error", "aborted"] as const)(
			`preserves ${role} images after a %s response`,
			(stopReason) => {
				const source = imageMessage(role);
				const assistant = fauxAssistantMessage("Response", {
					stopReason,
					...(stopReason === "error" || stopReason === "aborted" ? { errorMessage: "Request failed" } : {}),
					timestamp: 2,
				});
				const messages = [source, assistant];
				const snapshot = structuredClone(messages);
				const converted = convertToLlm(messages);

				expect(converted[0].role).toBe(role === "custom" ? "user" : role);
				expect(converted[0].content).toEqual(source.content);
				expect(converted[1]).toEqual(assistant);
				expect(messages).toEqual(snapshot);
			},
		);
	}

	it.each(["error", "aborted"] as const)(
		"preserves images when retrying after %s and prompting again",
		async (stopReason) => {
			const faux = registerFauxProvider({ models: [{ id: `retry-image-${stopReason}`, input: ["text", "image"] }] });
			const requests: Message[][] = [];
			const responses = [
				fauxAssistantMessage("Observed screenshot"),
				fauxAssistantMessage("", { stopReason, errorMessage: "Request interrupted" }),
				fauxAssistantMessage("Observed screenshot again"),
			];
			faux.setResponses(
				responses.map((response) => (context: Context) => {
					requests.push(structuredClone(context.messages));
					return response;
				}),
			);
			try {
				const agent = new Agent({
					initialState: { model: faux.getModel() },
					convertToLlm,
					getApiKey: () => "faux-key",
				});
				const source = imageMessage("user");
				const snapshot = structuredClone(source);
				await agent.prompt(source);
				await agent.prompt("Continue with the screenshot");
				expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason });
				await agent.continue();
				expect(requests).toHaveLength(3);
				for (const request of requests.slice(1)) {
					expect(
						request.find((message) => message.role === "user" && message.timestamp === source.timestamp)?.content,
					).toEqual(source.content);
				}
				expect(
					agent.state.messages.find(
						(message) => message.role === "user" && message.timestamp === source.timestamp,
					),
				).toEqual(snapshot);
			} finally {
				faux.unregister();
			}
		},
	);

	it("preserves prior user images in a later prompt", async () => {
		const faux = registerFauxProvider({ models: [{ id: "image-lifetime", input: ["text", "image"] }] });
		const requests: Message[][] = [];
		faux.setResponses(
			[1, 2].map(() => (context: Context) => {
				requests.push(structuredClone(context.messages));
				return fauxAssistantMessage("Observed screenshot");
			}),
		);
		try {
			const agent = new Agent({
				initialState: { model: faux.getModel() },
				convertToLlm,
				getApiKey: () => "faux-key",
			});
			const source = imageMessage("user");
			const snapshot = structuredClone(source);
			await agent.prompt(source);
			await agent.prompt("Continue using the observation");
			expect(requests).toHaveLength(2);
			expect(requests[0][0].content).toEqual(source.content);
			expect(requests[1][0].content).toEqual(source.content);
			expect(agent.state.messages[0]).toEqual(snapshot);
		} finally {
			faux.unregister();
		}
	});
});
