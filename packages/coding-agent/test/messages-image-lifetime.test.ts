import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";

const image: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLPsAAAAASUVORK5CYII=",
};
const placeholder: TextContent = { type: "text", text: "[Previously processed image omitted]" };
const roles = ["user", "custom", "toolResult"] as const;

function imageMessage(role: (typeof roles)[number]): Extract<AgentMessage, { role: (typeof roles)[number] }> {
	const content: (TextContent | ImageContent)[] = [
		{ type: "text", text: "Before screenshot" },
		{ ...image },
		{ type: "text", text: "After screenshot" },
		{ ...image },
	];
	if (role === "custom") {
		return { role, customType: "screenshot", content, display: true, timestamp: 1 };
	}
	if (role === "toolResult") {
		return { role, toolName: "read", toolCallId: "capture-1", content, isError: false, timestamp: 1 };
	}
	return { role, content, timestamp: 1 };
}

const consumedContent = [
	{ type: "text", text: "Before screenshot" },
	placeholder,
	{ type: "text", text: "After screenshot" },
	placeholder,
];

describe("convertToLlm image lifetime", () => {
	it("omits a processed screenshot tool result after a successful toolUse response", async () => {
		const faux = registerFauxProvider({ models: [{ id: "tool-image-lifetime", input: ["text", "image"] }] });
		const requests: Message[][] = [];
		const screenshot = imageMessage("toolResult");
		const responses = [
			fauxAssistantMessage(fauxToolCall("read", {}, { id: "capture-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("continue_work", {}, { id: "continue-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished using screenshot observation"),
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
							name: "read",
							label: "Read",
							description: "Read screenshot",
							parameters: Type.Object({}),
							execute: async () => ({ content: structuredClone(screenshot.content), details: {} }),
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
			await agent.prompt("Read screenshot and continue work");
			expect(requests).toHaveLength(3);
			const received = requests[1].find(
				(message) => message.role === "toolResult" && message.toolCallId === "capture-1",
			);
			const processed = requests[2].find(
				(message) => message.role === "toolResult" && message.toolCallId === "capture-1",
			);
			expect(received?.content).toEqual(screenshot.content);
			expect(processed?.content).toEqual(consumedContent);
			expect(
				agent.state.messages.find((message) => message.role === "toolResult" && message.toolCallId === "capture-1")
					?.content,
			).toEqual(screenshot.content);
		} finally {
			faux.unregister();
		}
	});

	it.each(["error", "aborted"] as const)(
		"retains newest screenshot on retry after %s without replaying consumed images",
		async (stopReason) => {
			const faux = registerFauxProvider({ models: [{ id: `retry-image-${stopReason}`, input: ["text", "image"] }] });
			const requests: Message[][] = [];
			const responses = [
				fauxAssistantMessage("Observed first screenshot"),
				fauxAssistantMessage("", { stopReason, errorMessage: "Request interrupted" }),
				fauxAssistantMessage("Observed newest screenshot"),
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
				const prior = imageMessage("user");
				const newest = imageMessage("user");
				newest.timestamp = 2;
				const snapshots = structuredClone([prior, newest]);
				await agent.prompt(prior);
				await agent.prompt(newest);
				expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason });
				await agent.continue();
				expect(requests).toHaveLength(3);
				for (const request of requests.slice(1)) {
					expect(request.find((message) => message.role === "user" && message.timestamp === 1)?.content).toEqual(
						consumedContent,
					);
					expect(request.find((message) => message.role === "user" && message.timestamp === 2)?.content).toEqual(
						newest.content,
					);
				}
				expect(agent.state.messages.filter((message) => message.role === "user")).toEqual(snapshots);
			} finally {
				faux.unregister();
			}
		},
	);

	for (const role of roles) {
		it.each(["stop", "toolUse", "length"] as const)(
			`expires ${role} images after a later %s response`,
			(stopReason) => {
				const source = imageMessage(role);
				const assistant = fauxAssistantMessage("Observed screenshot", { stopReason, timestamp: 2 });
				const messages = [source, assistant];
				const snapshot = structuredClone(messages);
				const converted = convertToLlm(messages);

				const expected =
					role === "custom"
						? { role: "user", timestamp: source.timestamp, content: consumedContent }
						: { ...source, content: consumedContent };
				expect(converted[0]).toEqual(expected);
				expect(converted[1]).toEqual(assistant);
				expect(messages).toEqual(snapshot);
			},
		);

		it.each(["error", "aborted"] as const)(`retains pending ${role} images after %s`, (stopReason) => {
			const source = imageMessage(role);
			const messages = [
				source,
				fauxAssistantMessage("Partial response", { stopReason, errorMessage: "Request failed" }),
			];
			const snapshot = structuredClone(messages);
			expect(convertToLlm(messages)[0].content).toEqual(source.content);
			expect(messages).toEqual(snapshot);
		});

		it(`retains newest ${role} images after an earlier successful response and later failure`, () => {
			const old = imageMessage(role);
			const newest = imageMessage(role);
			const messages = [
				old,
				fauxAssistantMessage("Observed old screenshot"),
				newest,
				fauxAssistantMessage("", { stopReason: "error" }),
			];
			const snapshot = structuredClone(messages);
			const converted = convertToLlm(messages);
			expect(converted[0].content).toEqual(consumedContent);
			expect(converted[2].content).toEqual(newest.content);
			expect(messages).toEqual(snapshot);
		});
	}

	it("sends pending images once, then placeholders on the next Agent request without changing history", async () => {
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
			expect(requests[1][0].content).toEqual(consumedContent);
			expect(agent.state.messages[0]).toEqual(snapshot);
			expect(source).toEqual(snapshot);
		} finally {
			faux.unregister();
		}
	});
});
