import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function expectCoherentToolResults(context: Context): void {
	const calls = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.add(block.id);
			}
		} else if (message.role === "toolResult") {
			expect(calls.has(message.toolCallId)).toBe(true);
		}
	}
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

describe("live compaction provider boundary", () => {
	it.each(["cancel", "failure", "abort"] as const)(
		"reports %s at the boundary without replaying tool effects",
		async (outcome) => {
			let effects = 0;
			let compactionCalls = 0;
			let assistantCount = 0;
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 100 }],
				settings: { compaction: { enabled: false, thresholdPercent: 50, keepRecentTokens: 1 } },
				tools: [
					{
						name: "effect",
						label: "Effect",
						description: "Record one effect",
						parameters: Type.Object({}),
						execute: async () => {
							effects++;
							return { content: [{ type: "text", text: "effect recorded" }], details: {} };
						},
					},
				],
				extensionFactories: [
					(pi) => {
						pi.on("message_end", (event) => {
							if (event.message.role !== "assistant") return;
							const tokens = ++assistantCount === 1 ? 64_000 : 100;
							return {
								message: {
									...event.message,
									usage: {
										input: tokens,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: tokens,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
								},
							};
						});
						pi.on("compaction", (event) => {
							compactionCalls++;
							if (outcome === "failure") throw new Error("boundary summary unavailable");
							if (outcome === "cancel") return { cancel: true };
							harness.session.abortCompaction();
							expect(event.signal.aborted).toBe(true);
							return {
								compaction: {
									summary: "aborted summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			for (let index = 0; index < 4; index++) {
				harness.sessionManager.appendMessage({
					role: "user",
					content: `history ${index}`,
					timestamp: Date.now() - 1_000,
				});
			}
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			let nextContext: Context | undefined;
			let callsAtNextRequest = 0;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
				(context) => {
					nextContext = { messages: structuredClone(context.messages) };
					callsAtNextRequest = compactionCalls;
					return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "complete" }), { stopReason: "toolUse" });
				},
			]);
			await harness.session.prompt("run effect");
			expect(callsAtNextRequest).toBe(1);
			expect(compactionCalls).toBe(1);
			expect(effects).toBe(1);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(nextContext).toBeDefined();
			if (nextContext) expectCoherentToolResults(nextContext);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				aborted: outcome !== "failure",
				result: undefined,
				willRetry: false,
			});
			if (outcome === "failure")
				expect(harness.eventsOfType("compaction_end")[0].errorMessage).toContain("boundary summary unavailable");
			expect(harness.faux.state.callCount).toBe(2);
		},
	);
	it.each([
		{ usage: 500_000, output: "effect complete", compacts: true },
		{ usage: 557_000, output: "effect complete", compacts: true },
		{ usage: 499_000, output: "effect complete", compacts: false },
		{ usage: 499_000, output: "x".repeat(8_000), compacts: true },
	])("checks usage $usage and tool output before another provider request", async ({ usage, output, compacts }) => {
		const started = deferred();
		const release = deferred();
		const effects: number[] = [];
		const requests: Array<{ context: Context; compactions: number; ended: number }> = [];
		let assistantCount = 0;
		let compactionCalls = 0;
		const effect: AgentTool = {
			name: "effect",
			label: "Effect",
			description: "Record an effect once",
			parameters: Type.Object({ index: Type.Number() }),
			execute: async (_id, params) => {
				effects.push(params.index);
				if (params.index === 1) {
					started.resolve();
					await release.promise;
				}
				return { content: [{ type: "text", text: output }], details: {} };
			},
		};
		const harness = await createHarness({
			persistedSession: true,
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, thresholdPercent: 50, keepRecentTokens: 1, reserveTokens: 100 } },
			tools: [effect],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return;
						assistantCount++;
						const tokens = assistantCount === 1 ? usage : 0;
						return {
							message: {
								...event.message,
								usage: {
									input: tokens,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: tokens,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							},
						};
					});
					pi.on("compaction", (event) => {
						compactionCalls++;
						return {
							compaction: {
								summary: "live boundary summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		for (let index = 0; index < 4; index++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `old history ${index}` }],
				timestamp: Date.now() - 1_000,
			});
			harness.sessionManager.appendMessage(
				fauxAssistantMessage(`old response ${index}`, { timestamp: Date.now() - 1_000 }),
			);
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("effect", { index: 1 }), fauxToolCall("effect", { index: 2 })], {
				stopReason: "toolUse",
			}),
			(context) => {
				requests.push({
					context: { messages: structuredClone(context.messages) },
					compactions: harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length,
					ended: harness.eventsOfType("agent_end").length,
				});
				return fauxAssistantMessage(fauxToolCall("effect", { index: 3 }), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push({
					context: { messages: structuredClone(context.messages) },
					compactions: harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length,
					ended: harness.eventsOfType("agent_end").length,
				});
				return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "completed" }), { stopReason: "toolUse" });
			},
		]);
		const prompt = harness.session.prompt("run all three effects");
		try {
			await started.promise;
			expect(harness.session.isStreaming).toBe(true);
			expect(compactionCalls).toBe(0);
			expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		} finally {
			release.resolve();
			await prompt;
		}
		expect(requests).toHaveLength(2);
		expect(requests.map((request) => request.compactions)).toEqual(compacts ? [1, 1] : [0, 0]);
		expect(requests.map((request) => request.ended)).toEqual([0, 0]);
		expect(compactionCalls).toBe(compacts ? 1 : 0);
		for (const request of requests) expectCoherentToolResults(request.context);
		expect(requests[0].context.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		if (compacts) {
			expect(JSON.stringify(requests[0].context.messages)).toContain("live boundary summary");
			expect(JSON.stringify(requests[0].context.messages)).not.toContain("old history 0");
		}
		expect(effects.toSorted()).toEqual([1, 2, 3]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
