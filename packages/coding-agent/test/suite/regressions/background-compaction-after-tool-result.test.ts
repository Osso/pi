import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("speculative background compaction after a tool result", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
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
