import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const daybreakError = "Codex error: Unable to verify Daybreak Blue access. Please try again.";
const handshakeError =
	"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code";

function completedAssistantMessage(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([{ type: "text", text }, fauxToolCall("end_turn", { reason: text })], {
		stopReason: "toolUse",
	});
}

describe.each([
	{
		name: "Daybreak Blue access verification",
		transientError: daybreakError,
		recoveryErrors: [daybreakError, `${daybreakError}\nOpenAI request ID: req_daybreak_123`],
		permanentErrors: [
			"Codex error: Daybreak Blue access denied. Please try again.",
			"Codex error: Daybreak Blue access denied. Please try again.\nOpenAI request ID: req_denied_123",
		],
	},
	{
		name: "WebSocket Expected-101 handshake",
		transientError: handshakeError,
		recoveryErrors: [handshakeError, `Error: ${handshakeError}`],
		permanentErrors: [
			"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: 401 Unauthorized",
			"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: 403 Forbidden",
			"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: 400 Bad Request",
		],
	},
])("AgentSession $name retries", ({ transientError, recoveryErrors, permanentErrors }) => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each(recoveryErrors)("recovers a completed reply after transient failure: %s", async (errorMessage) => {
		const harness = await createHarness({
			initialActiveToolNames: ["end_turn"],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			completedAssistantMessage("Recovered reply"),
		]);

		await harness.session.prompt("Reply after the transient failure recovers");

		expect(getAssistantTexts(harness)).toContain("Recovered reply");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		expect(harness.eventsOfType("tool_execution_end")).toEqual([
			expect.objectContaining({ toolName: "end_turn", isError: false }),
		]);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

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

		await harness.session.prompt("Recover within the retry budget");

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

	it("does not retry when retries are disabled", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["end_turn"],
			settings: { retry: { enabled: false, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: transientError }),
			completedAssistantMessage("Must remain unconsumed"),
		]);

		await harness.session.prompt("Report the error without retrying");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: transientError });
		expect(harness.session.isRetrying).toBe(false);
	});

	it("cancels retry backoff without consuming the recovery reply", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["end_turn"],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: transientError }),
			completedAssistantMessage("Must remain unconsumed"),
		]);
		const retryStarted = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") resolve();
			});
		});

		const prompt = harness.session.prompt("Cancel during backoff");
		await Promise.race([retryStarted, prompt]);
		harness.session.abortRetry();
		await prompt;

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([
			expect.objectContaining({ success: false, finalError: "Retry cancelled" }),
		]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.isStreaming).toBe(false);
	});

	it.each(permanentErrors)("does not retry permanent failure: %s", async (errorMessage) => {
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
