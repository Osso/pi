import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

// Upstream #8537: a custom message sent with triggerTurn false while a tool ran was appended between the assistant
// tool call and its result, and providers that validate message order rejected the replayed history.
describe("#8537 custom messages injected during tool execution", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("appends the message after the turn's tool results in state, session entries and events", async () => {
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				// A background task (for example a subagent reply) notifies the session while the tool still runs.
				await harness?.session.sendCustomMessage(
					{ customType: "subagent-reply", content: "subagent replied", display: true },
					{ triggerTurn: false },
				);
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};
		harness = await createHarness({ tools: [waitTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		const expected = ["user", "assistant", "toolResult", "custom", "assistant"];
		expect(harness.session.messages.map((message) => message.role).slice(0, 5)).toEqual(expected);
		const entryKinds = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" ? [entry.message.role] : entry.type === "custom_message" ? ["custom"] : [],
			);
		expect(entryKinds.slice(0, 5)).toEqual(expected);
		const messageStarts = harness.events.flatMap((event) =>
			event.type === "message_start" ? [event.message.role] : [],
		);
		expect(messageStarts.slice(0, 5)).toEqual(expected);

		// Every tool result in the LLM history directly follows the assistant message that called it.
		let openToolCallIds = new Set<string>();
		for (const message of convertToLlm(harness.session.messages)) {
			if (message.role === "toolResult") {
				expect(openToolCallIds.has(message.toolCallId)).toBe(true);
				openToolCallIds.delete(message.toolCallId);
				continue;
			}
			openToolCallIds = new Set(
				message.role === "assistant"
					? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
					: [],
			);
		}
	});
});
