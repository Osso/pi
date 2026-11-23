import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/12119
 *
 * /copy uses getLastAssistantText(), which took the last assistant message and skipped only aborted
 * messages with no content. Turns whose last assistant message has no text (Esc during a tool call, a
 * provider error, or an `end_turn` call sent after a plain text reply) made /copy say
 * "No agent messages to copy yet." while the answer was on screen.
 */
const ANSWER = "Here is the answer.";

function answerAndEndTurn() {
	return fauxAssistantMessage([fauxText(ANSWER), fauxToolCall("end_turn", { reason: "answered" })], {
		stopReason: "toolUse",
	});
}

describe("issue #12119 /copy after a turn without final text", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("returns the previous answer after Esc during a tool call", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Blocks until aborted",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				markToolStarted();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "tool aborted" }], details: {} };
			},
		};
		harness = await createHarness({ tools: [blockingTool] });
		harness.setResponses([
			answerAndEndTurn(),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("first question");
		const run = harness.session.prompt("run the blocking tool");
		await toolStarted;
		await harness.session.abort();
		await run;

		expect(harness.session.getLastAssistantText()).toBe(ANSWER);
	});

	it("returns the previous answer after a provider error", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([
			answerAndEndTurn(),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error" }),
		]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		expect(harness.session.getLastAssistantText()).toBe(ANSWER);
	});

	it("returns a plain text reply followed by a separate end_turn call", async () => {
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(ANSWER),
			fauxAssistantMessage(fauxToolCall("end_turn", { reason: "answered" }), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("question");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe(ANSWER);
	});

	it("includes signed public narration and leaves genuine thinking out", async () => {
		const narrationSignature = (
			JSON.parse(readFileSync(new URL("../../fixtures/anthropic-narration.json", import.meta.url), "utf8")) as {
				content: Array<{ thinkingSignature: string }>;
			}
		).content[1].thinkingSignature;
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxText("Intro. "),
					fauxThinking("Private reasoning"),
					{ ...fauxThinking("Public reply"), thinkingSignature: narrationSignature },
					fauxToolCall("end_turn", { reason: "answered" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					{ ...fauxThinking("Only narration"), thinkingSignature: narrationSignature },
					fauxToolCall("end_turn", { reason: "answered" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.prompt("first question");
		expect(harness.session.getLastAssistantText()).toBe("Intro. Public reply");

		await harness.session.prompt("second question");
		expect(harness.session.getLastAssistantText()).toBe("Only narration");
	});
});
