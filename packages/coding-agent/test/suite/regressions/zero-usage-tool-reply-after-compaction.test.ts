import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

it.each([
	{ output: "x".repeat(8_000), compacts: true },
	{ output: "small result", compacts: false },
])(
	"a zero-usage tool reply after compaction checks the rebuilt context (compacts: $compacts)",
	async ({ output, compacts }) => {
		let compactionCalls = 0;
		const effect: AgentTool = {
			name: "effect",
			label: "Effect",
			description: "Return a tool result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
		};
		const harness = await createHarness({
			persistedSession: true,
			models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 100 }],
			settings: {
				compaction: { enabled: true, thresholdTokens: 2_000, reserveTokens: 4_000, keepRecentMessages: 3 },
			},
			tools: [effect],
			extensionFactories: [
				(pi) => {
					// The provider reports no usage for new replies.
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						return { message: { ...event.message, usage: { ...zeroUsage, cost } } };
					});
					pi.on("compaction", (event) => {
						compactionCalls++;
						return {
							compaction: {
								summary: "threshold summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const old = Date.now() - 10_000;
		const firstKept = harness.sessionManager.appendMessage({
			role: "user",
			content: "kept question",
			timestamp: old,
		});
		// Kept reply whose usage describes the pre-compaction context.
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("kept answer", { timestamp: old }),
			usage: { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000, cost },
		});
		harness.sessionManager.appendCompaction("manual summary", firstKept, 50_000);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let compactionsAtNextRequest = -1;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
			() => {
				compactionsAtNextRequest = compactionCalls;
				return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "done" }), { stopReason: "toolUse" });
			},
		]);
		await harness.session.prompt("call the effect");

		expect(compactionsAtNextRequest).toBe(compacts ? 1 : 0);
	},
);
