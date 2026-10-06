import { type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const PHASE_MS = 1_000;

const waitForAbort: FauxResponseFactory = async (_context, options) => {
	const signal = options?.signal;
	if (!signal) throw new Error("Expected provider cancellation signal");
	if (!signal.aborted) {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	}
	return fauxAssistantMessage("Never delivered");
};

function completedResponse(text: string) {
	return fauxAssistantMessage([fauxText(text), fauxToolCall("end_turn", { reason: text })], { stopReason: "toolUse" });
}

async function recoveryHarness(): Promise<Harness> {
	const harness = await createHarness({
		thinkingPhaseTimeoutMs: PHASE_MS,
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

function observeSettlement(operation: Promise<void>): { settled: () => boolean; result: Promise<unknown> } {
	let settled = false;
	const result = operation.then(
		() => {
			settled = true;
		},
		(error: unknown) => {
			settled = true;
			return error;
		},
	);
	return { settled: () => settled, result };
}

describe("AgentSession thinking watchdog recovery", () => {
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.useRealTimers();
	});

	it("uses a twenty-minute default and continues without duplicating input", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([waitForAbort, completedResponse("Recovered")]);
		const dispatch = observeSettlement(harness.session.prompt("Original input"));
		await vi.advanceTimersByTimeAsync(20 * 60 * 1_000 - 1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(dispatch.settled()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(dispatch.result).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("Recovered");
		expect(getUserTexts(harness)).toEqual(["Original input"]);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, maxAttempts: 1 }]);
	});

	it("keeps the public dispatch pending through recovery and stops on the second timeout", async () => {
		vi.useFakeTimers();
		const harness = await recoveryHarness();
		harness.setResponses([waitForAbort, waitForAbort, completedResponse("Must stay queued")]);
		const dispatch = observeSettlement(harness.session.prompt("Work"));
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		expect(dispatch.settled()).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.hasActiveRetry).toBe(true);
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		await expect(dispatch.result).resolves.toEqual(new Error("Main session thinking phase exceeded 20 minutes"));
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.hasActiveRetry).toBe(false);
		expect(getUserTexts(harness)).toEqual(["Work"]);
		await harness.session.prompt("Next explicit input");
		expect(harness.session.getLastAssistantText()).toBe("Must stay queued");
	});

	it("resets the allowance for a new explicit prompt", async () => {
		vi.useFakeTimers();
		const harness = await recoveryHarness();
		harness.setResponses([waitForAbort, completedResponse("First"), waitForAbort, completedResponse("Second")]);
		const first = observeSettlement(harness.session.prompt("First input"));
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		await expect(first.result).resolves.toBeUndefined();
		const second = observeSettlement(harness.session.prompt("Second input"));
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		await expect(second.result).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("Second");
		expect(getUserTexts(harness)).toEqual(["First input", "Second input"]);
	});

	it("recovers an explicit continuation without adding user input", async () => {
		vi.useFakeTimers();
		const harness = await recoveryHarness();
		harness.setResponses([fauxAssistantMessage("Interrupted", { stopReason: "aborted" })]);
		await harness.session.prompt("Existing input");
		harness.setResponses([waitForAbort, completedResponse("Continued")]);
		const continuation = observeSettlement(harness.session.continue());
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		await expect(continuation.result).resolves.toBeUndefined();
		expect(harness.session.getLastAssistantText()).toBe("Continued");
		expect(getUserTexts(harness)).toEqual(["Existing input"]);
	});

	it.each([false, true])("does not retry manual cancellation (recovery already started: %s)", async (recoverFirst) => {
		vi.useFakeTimers();
		const harness = await recoveryHarness();
		harness.setResponses([waitForAbort, waitForAbort, completedResponse("Must stay queued")]);
		const dispatch = observeSettlement(harness.session.prompt("Work"));
		await vi.advanceTimersByTimeAsync(recoverFirst ? PHASE_MS : 0);
		await harness.session.abort();
		await vi.advanceTimersByTimeAsync(3 * PHASE_MS);
		await expect(dispatch.result).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(recoverFirst ? 2 : 1);
		expect(harness.session.hasActiveRetry).toBe(false);
	});

	it("cancels watchdog recovery through the existing retry cancellation API", async () => {
		vi.useFakeTimers();
		const harness = await recoveryHarness();
		harness.setResponses([waitForAbort, waitForAbort, completedResponse("Must stay queued")]);
		const dispatch = observeSettlement(harness.session.prompt("Work"));
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		harness.session.abortRetry();
		await vi.advanceTimersByTimeAsync(3 * PHASE_MS);
		await expect(dispatch.result).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			finalError: "Retry cancelled",
		});
	});

	it("lets cancellation win while recovery waits for the turn-start lock", async () => {
		vi.useFakeTimers();
		let releaseInput!: () => void;
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const harness = await createHarness({
			thinkingPhaseTimeoutMs: PHASE_MS,
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "Hold lock") return { action: "continue" };
						await inputGate;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([waitForAbort, completedResponse("Must stay queued")]);
		const dispatch = observeSettlement(harness.session.prompt("Work"));
		await vi.advanceTimersByTimeAsync(0);
		const heldInput = harness.session.prompt("Hold lock", { streamingBehavior: "followUp" });
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		expect(dispatch.settled()).toBe(false);
		await harness.session.abort();
		releaseInput();
		await heldInput;
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		await expect(dispatch.result).resolves.toBeUndefined();
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["Work"]);
	});

	it("delivers input queued at watchdog agent_end exactly once before recovery", async () => {
		vi.useFakeTimers();
		let harness: Harness;
		harness = await createHarness({
			thinkingPhaseTimeoutMs: PHASE_MS,
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async (event) => {
						if (
							event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")
						) {
							await harness.session.followUp("Queued correction");
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([waitForAbort, completedResponse("Recovered with correction")]);
		const dispatch = observeSettlement(harness.session.prompt("Work"));
		await vi.advanceTimersByTimeAsync(PHASE_MS);
		await expect(dispatch.result).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["Work", "Queued correction"]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.getLastAssistantText()).toBe("Recovered with correction");
	});

	it("shares one allowance with post-run compact-and-continue work", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			thinkingPhaseTimeoutMs: PHASE_MS,
			models: [{ id: "small", contextWindow: 8192 }],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("compaction", async (event) => ({
						compaction: {
							summary: "Saved work",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([completedResponse("Earlier work")]);
		await harness.session.prompt("Earlier input");
		harness.setResponses([
			waitForAbort,
			() => fauxAssistantMessage("Length-limited work ".repeat(800), { stopReason: "length" }),
			waitForAbort,
			completedResponse("Must stay queued"),
		]);
		const dispatch = observeSettlement(harness.session.prompt("Work"));
		await vi.advanceTimersByTimeAsync(2 * PHASE_MS);
		await expect(dispatch.result).resolves.toEqual(new Error("Main session thinking phase exceeded 20 minutes"));
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ willRetry: true, aborted: false }]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
