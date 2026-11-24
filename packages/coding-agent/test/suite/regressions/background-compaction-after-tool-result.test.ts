import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("speculative background compaction after a tool result", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts before the next provider request when a tool result crosses backgroundStartTokens", async () => {
		const largeTool: AgentTool = {
			name: "large_tool",
			label: "Large Tool",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(10_000) }], details: {} }),
		};
		const providerCallsAtStart: number[] = [];
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentMessages: 1, backgroundStartTokens: 2_500, thresholdTokens: 70_000 },
			},
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 100 }],
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("background_compaction_start", () => {
						providerCallsAtStart.push(harness.faux.state.callCount);
					});
					pi.on("compaction", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("older answer"),
			fauxAssistantMessage(fauxToolCall("large_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("older question");
		await harness.session.prompt("run the tool");

		// One start, after the tool-call request and before the request that sees the tool result.
		expect(providerCallsAtStart).toEqual([2]);
	});

	it("preserves foreground overflow recovery after a rate-limited background failure", async () => {
		const rateLimitError = "429 Too Many Requests: rate limit reached for requests";
		const overflowError = "Error: exceeded request buffer limit while retrying upstream";
		let generationEnded = () => {};
		const backgroundEnded = new Promise<void>((resolve) => {
			generationEnded = resolve;
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentMessages: 1, backgroundStartTokens: 40, thresholdTokens: 70_000 },
			},
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("background_compaction_end", () => generationEnded());
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "older question" }],
			timestamp: now - 2_000,
		});
		harness.sessionManager.appendMessage(fauxAssistantMessage("older answer", { timestamp: now - 1_500 }));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "background trigger" }],
			timestamp: now - 1_000,
		});
		const triggerMessage = {
			...fauxAssistantMessage("triggered background compaction", { timestamp: now - 500 }),
			usage: {
				input: 40,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 40,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		harness.sessionManager.appendMessage(triggerMessage);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let overflowRetryCount = 0;
		const retryAnswer = () => {
			overflowRetryCount++;
			return {
				...fauxAssistantMessage("answered after overflow recovery"),
				usage: {
					input: 1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		};
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: rateLimitError }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: overflowError }),
			fauxAssistantMessage("foreground compaction summary"),
			retryAnswer,
		]);

		await (
			harness.session as unknown as {
				_checkCompaction: (message: ReturnType<typeof fauxAssistantMessage>) => Promise<boolean>;
			}
		)._checkCompaction(triggerMessage);
		await backgroundEnded;
		await harness.session.prompt("next question");

		expect(harness.eventsOfType("compaction_start")).toContainEqual(expect.objectContaining({ reason: "overflow" }));
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "overflow", aborted: false, willRetry: true }),
		);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(
			harness.session.messages.some((message) =>
				JSON.stringify(message).includes("answered after overflow recovery"),
			),
		).toBe(true);
		expect(overflowRetryCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("runs no compaction hook when the speculative compaction is aborted at its start event", async () => {
		const largeTool: AgentTool = {
			name: "large_tool",
			label: "Large Tool",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(10_000) }], details: {} }),
		};
		const events: string[] = [];
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentMessages: 1, backgroundStartTokens: 2_500, thresholdTokens: 70_000 },
			},
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 100 }],
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("background_compaction_start", () => {
						events.push("start");
						harness.session.abortCompaction();
					});
					pi.on("compaction", async () => {
						events.push("compaction");
						return { cancel: true };
					});
					pi.on("background_compaction_end", () => {
						events.push("end");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("older answer"),
			fauxAssistantMessage(fauxToolCall("large_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("older question");
		await harness.session.prompt("run the tool");
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(events).toEqual(["start", "end"]);
	});
});
