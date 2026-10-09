import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	getModel,
	registerFauxProvider,
	type SimpleStreamOptions,
	type StreamOptions,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateBranchSummary,
	materializeCompactionSummary,
} from "../src/core/compaction/index.ts";
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
		let capturedOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, context, options) => {
			capturedContext = context;
			capturedOptions = options;
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
		expect(capturedOptions?.cacheRetention).toBe("none");
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

describe.each(["default provider", "session streamFn"])("uncached summarization via %s", (dispatch) => {
	let faux: FauxProviderRegistration;
	let capturedOptions: (StreamOptions | undefined)[];
	const streamFn: StreamFn | undefined = dispatch === "session streamFn" ? streamSimple : undefined;
	const messages: AgentMessage[] = [{ role: "user", content: "Investigate the compaction bug.", timestamp: 1 }];

	beforeEach(() => {
		faux = registerFauxProvider({ api: "compaction-options-faux", provider: "compaction-options-faux" });
		capturedOptions = [];
		faux.setResponses(
			Array.from({ length: 2 }, () => (_context: Context, options: StreamOptions | undefined) => {
				capturedOptions.push(options);
				return fauxAssistantMessage("## Goal\nFix compaction.");
			}),
		);
	});

	afterEach(() => faux.unregister());

	it.each([false, true])(
		"marks history and any split-turn prefix as one-off requests (split=%s)",
		async (isSplitTurn) => {
			const preparation: CompactionPreparation = {
				firstKeptEntryId: "retained-message",
				messagesToSummarize: messages,
				turnPrefixMessages: isSplitTurn ? messages : [],
				isSplitTurn,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
			};
			const result = await compact(
				preparation,
				faux.getModel(),
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			);

			expect(result.summary).toContain("## Goal\nFix compaction.");
			if (isSplitTurn) expect(result.summary).toContain("**Turn Context (split turn):**");
			expect(capturedOptions).toHaveLength(isSplitTurn ? 2 : 1);
			for (const options of capturedOptions) {
				expect(options).toMatchObject({ apiKey: "test-key", cacheRetention: "none" });
			}
		},
	);

	it("marks branch summaries as one-off requests", async () => {
		const result = await generateBranchSummary(
			[
				{
					type: "message",
					id: "branch-message",
					parentId: null,
					timestamp: "2026-10-09T00:00:00.000Z",
					message: messages[0],
				},
			],
			{
				model: faux.getModel(),
				apiKey: "test-key",
				signal: new AbortController().signal,
				streamFn,
			},
		);

		expect(result.summary).toContain("## Goal\nFix compaction.");
		expect(capturedOptions).toHaveLength(1);
		expect(capturedOptions[0]).toMatchObject({ apiKey: "test-key", cacheRetention: "none" });
	});
});
