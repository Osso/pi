import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantStream(message: AssistantMessage): EventStream<AssistantMessageEvent, AssistantMessage> {
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type");
		},
	);
	queueMicrotask(() =>
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }),
	);
	return stream;
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("agentLoopContinue restored tool-batch termination", () => {
	it.each([
		{ savedToolCallId: "read-call", pendingToolCallId: "end-call" },
		{ savedToolCallId: "end-call", pendingToolCallId: "read-call" },
	])(
		"continues after resuming a mixed batch with saved $savedToolCallId",
		async ({ savedToolCallId, pendingToolCallId }) => {
			const executedToolCallIds: string[] = [];
			const readSchema = Type.Object({ path: Type.String() });
			const readTool: AgentTool<typeof readSchema, { path: string }> = {
				name: "read",
				label: "Read",
				description: "Read a note",
				parameters: readSchema,
				async execute(toolCallId, params) {
					executedToolCallIds.push(toolCallId);
					return { content: [{ type: "text", text: "Note content" }], details: { path: params.path } };
				},
			};
			const endTurnSchema = Type.Object({ reason: Type.String() });
			const endTurnTool: AgentTool<typeof endTurnSchema, { reason: string }> = {
				name: "end_turn",
				label: "End turn",
				description: "End the turn",
				parameters: endTurnSchema,
				async execute(toolCallId, params) {
					executedToolCallIds.push(toolCallId);
					return {
						content: [{ type: "text", text: `Turn ended: ${params.reason}` }],
						details: { reason: params.reason },
						terminate: true,
					};
				},
			};
			const toolCalls = [
				{ type: "toolCall" as const, id: "read-call", name: "read", arguments: { path: "note.txt" } },
				{ type: "toolCall" as const, id: "end-call", name: "end_turn", arguments: { reason: "Done" } },
			];
			const assistantMessage = createAssistantMessage(toolCalls, "toolUse");
			const savedToolName = savedToolCallId === "read-call" ? "read" : "end_turn";
			const savedResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: savedToolCallId,
				toolName: savedToolName,
				content: [{ type: "text", text: savedToolName === "read" ? "Note content" : "Turn ended: Done" }],
				isError: false,
				timestamp: Date.now(),
			};
			const context: AgentContext = {
				systemPrompt: "",
				messages: [
					{ role: "user", content: "Read note.txt and report its content", timestamp: Date.now() },
					assistantMessage,
					savedResult,
				],
				tools: [readTool, endTurnTool],
			};
			let modelRequests = 0;
			const streamFn: StreamFn = () => {
				modelRequests++;
				return createAssistantStream(
					createAssistantMessage(
						[{ type: "toolCall", id: "follow-up-end-call", name: "end_turn", arguments: { reason: "Done" } }],
						"toolUse",
					),
				);
			};
			const stream = agentLoopContinue(
				context,
				{
					model: createModel(),
					convertToLlm: identityConverter,
				},
				undefined,
				streamFn,
			);

			for await (const _event of stream) {
				// Consume the loop before reading its result.
			}
			const messages = await stream.result();

			expect(executedToolCallIds).toEqual([pendingToolCallId, "follow-up-end-call"]);
			expect(modelRequests).toBe(1);
			expect(messages.map((message) => message.role)).toEqual(["toolResult", "assistant", "toolResult"]);
		},
	);
});
