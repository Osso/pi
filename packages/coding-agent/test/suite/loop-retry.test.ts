import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import loopExtension from "../../extensions/loop/src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

const LOOP_PROMPT = "check progress";
const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function endTurn(reason: string) {
	return fauxAssistantMessage([fauxToolCall("end_turn", { reason })], { stopReason: "toolUse" });
}

function loopEntries(harness: Harness): number {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "loop").length;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("loop with automatic retry", () => {
	// A failed loop turn ends a run before its automatic retry; a tick during the retry delay must not
	// queue a second loop prompt while the first is still in progress.
	it("skips ticks while the loop prompt waits for an automatic retry", async () => {
		const harness = await createHarness({
			extensionFactories: [loopExtension],
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1_300 } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "rpc" });
		let retried = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("loop", { action: "start", intervalSeconds: 1, prompt: LOOP_PROMPT }), {
				stopReason: "toolUse",
			}),
			endTurn("Loop started."),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			() => {
				retried = true;
				return fauxAssistantMessage(fauxToolCall("loop", { action: "stop" }), { stopReason: "toolUse" });
			},
			endTurn("Loop stopped."),
			endTurn("Unexpected second loop prompt."),
			endTurn("Unexpected extra turn."),
		]);

		await harness.session.prompt("Start the loop.");
		await waitFor(() => retried, "the retried loop turn");
		await waitFor(() => !harness.session.isDispatching, "the loop turn to settle");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await harness.session.agent.waitForIdle();

		expect(loopEntries(harness)).toBe(1);
	}, 20_000);
});
