import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	getModel,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { materializeCompactionSummary } from "../src/core/compaction/index.ts";
import type { CompactionEntry } from "../src/core/session-manager.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(model: { provider: string; api: string; id: string }, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createCompactionEntry(): CompactionEntry {
	return {
		type: "compaction",
		id: "compaction-1",
		parentId: "message-1",
		timestamp: "2026-08-08T00:00:00.000Z",
		summary: "OpenAI native compaction stored in session entry details.",
		firstKeptEntryId: "message-2",
		tokensBefore: 42_000,
		providerNative: {
			provider: "openai-codex",
			api: "openai-codex-responses",
			format: "openai.responses.input",
			value: [{ type: "compaction_summary", encrypted_content: "encrypted-checkpoint" }],
		},
		details: { type: "openai-remote-compaction", replacementHistory: [{ type: "compaction_summary" }] },
	};
}

function getText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}

describe("materializeCompactionSummary", () => {
	it("returns the provider response after sending intact native context and a plaintext-summary request", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		if (!model) throw new Error("Expected OpenAI Codex test model");
		const entry = createCompactionEntry();
		let capturedContext: Context | undefined;
		const streamFn: StreamFn = (_model, context) => {
			capturedContext = context;
			const stream = new MockAssistantStream();
			const response = createAssistantMessage(model, "## Goal\n\nContinue from the encrypted checkpoint.");
			queueMicrotask(() => {
				stream.push({ type: "start", partial: response });
				stream.push({ type: "done", reason: "stop", message: response });
			});
			return stream;
		};

		const result = await materializeCompactionSummary(entry, model, {
			reserveTokens: 16_384,
			apiKey: "test-key",
			streamFn,
		});

		expect(result).toEqual({
			aborted: false,
			summary: "## Goal\n\nContinue from the encrypted checkpoint.",
		});
		if (!capturedContext) throw new Error("Expected materialization request context");
		const instruction = capturedContext.messages[1];
		if (!instruction) throw new Error("Expected materialization instruction");
		expect(capturedContext.messages).toHaveLength(2);
		expect(capturedContext.messages[0]).toMatchObject({
			role: "user",
			providerNative: entry.providerNative,
		});
		expect(instruction.role).toBe("user");
		expect(getText(instruction)).toContain("complete plaintext continuation summary");
		expect(getText(instruction)).toContain("Return only the summary text");
	});

	it("reports an aborted provider response without producing a summary", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		if (!model) throw new Error("Expected OpenAI Codex test model");
		const streamFn: StreamFn = () => {
			const stream = new MockAssistantStream();
			const started = createAssistantMessage(model, "");
			const aborted = { ...started, stopReason: "aborted" as const };
			queueMicrotask(() => {
				stream.push({ type: "start", partial: started });
				stream.push({ type: "error", reason: "aborted", error: aborted });
			});
			return stream;
		};

		await expect(
			materializeCompactionSummary(createCompactionEntry(), model, {
				reserveTokens: 16_384,
				apiKey: "test-key",
				streamFn,
			}),
		).resolves.toEqual({ aborted: true });
	});
});
