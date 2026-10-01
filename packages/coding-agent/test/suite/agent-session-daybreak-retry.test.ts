import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const transientError = "Codex error: Unable to verify Daybreak Blue access. Please try again.";

function completedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

describe("AgentSession Daybreak Blue access verification retries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([transientError, `${transientError}\nOpenAI request ID: req_daybreak_123`])(
		"recovers a completed reply after verification fails: %s",
		async (errorMessage) => {
			const harness = await createHarness({
				initialActiveToolNames: ["end_turn"],
				settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				completedAssistantMessage("Daybreak Blue recovered reply"),
			]);

			await harness.session.prompt("Reply after access verification recovers");

			expect(getAssistantTexts(harness)).toContain("Daybreak Blue recovered reply");
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
			expect(harness.eventsOfType("tool_execution_end")).toEqual([
				expect.objectContaining({ toolName: "end_turn", isError: false }),
			]);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.session.isStreaming).toBe(false);
		},
	);

	it("stops after the configured retry budget without consuming a later reply", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["end_turn"],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: transientError }),
			),
			completedAssistantMessage("Must remain unconsumed"),
		]);

		await harness.session.prompt("Verify access within the retry budget");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("Must remain unconsumed");
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, finalError: transientError }),
		]);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, true, false]);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: transientError });
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	it.each([
		"Codex error: Daybreak Blue access denied. Please try again.",
		"Codex error: Daybreak Blue access denied. Please try again.\nOpenAI request ID: req_denied_123",
	])("does not retry permanent access denial: %s", async (errorMessage) => {
		const harness = await createHarness({
			initialActiveToolNames: ["end_turn"],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			completedAssistantMessage("Must remain unconsumed"),
		]);

		await harness.session.prompt("Report denied access");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage });
		expect(harness.session.isRetrying).toBe(false);
	});
});
