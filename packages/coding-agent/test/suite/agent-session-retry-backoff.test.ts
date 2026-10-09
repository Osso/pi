import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrySettings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const transientFailure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

describe("AgentSession exponential retry backoff", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function setup(retry: RetrySettings = {}): Promise<Harness> {
		harness = await createHarness({ noSupervisor: true, settings: { retry } });
		harness.session.setActiveToolsByName([]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		return harness;
	}

	it.each([
		{ random: 0, delays: [24_000, 48_000, 96_000, 192_000, 240_000, 240_000] },
		{ random: 0.5, delays: [30_000, 60_000, 120_000, 240_000, 300_000, 300_000] },
		{ random: 1, delays: [36_000, 72_000, 144_000, 288_000, 300_000, 300_000] },
	])("sleeps exactly the emitted exponential delays for random=$random", async ({ random, delays }) => {
		const current = await setup();
		vi.spyOn(Math, "random").mockReturnValue(random);
		current.setResponses([...delays.map(transientFailure), fauxAssistantMessage("recovered")]);
		const prompt = current.session.prompt("test");
		await vi.advanceTimersByTimeAsync(0);

		for (const [index, delayMs] of delays.entries()) {
			expect(current.eventsOfType("auto_retry_start")[index]).toMatchObject({
				attempt: index + 1,
				maxAttempts: 30,
				delayMs,
			});
			expect(current.session.isRetrying).toBe(true);
			expect(current.faux.state.callCount).toBe(index + 1);
			await vi.advanceTimersByTimeAsync(delayMs - 1);
			expect(current.faux.state.callCount).toBe(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(current.faux.state.callCount).toBe(index + 2);
		}
		await prompt;
		expect(current.eventsOfType("auto_retry_end")).toEqual([{ type: "auto_retry_end", success: true, attempt: 6 }]);
		expect(current.session.retryAttempt).toBe(0);
		expect(current.session.isRetrying).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses an explicit session cap independently of provider retry limits", async () => {
		const current = await setup({ baseDelayMs: 1000, maxDelayMs: 2500, provider: { maxRetryDelayMs: 60000 } });
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		current.setResponses([transientFailure(), transientFailure(), transientFailure(), fauxAssistantMessage("ok")]);
		const prompt = current.session.prompt("test");
		await vi.advanceTimersByTimeAsync(0);
		for (const delay of [1000, 2000, 2500]) await vi.advanceTimersByTimeAsync(delay);
		await prompt;
		expect(current.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([1000, 2000, 2500]);
		expect(current.settingsManager.getProviderRetrySettings().maxRetryDelayMs).toBe(60000);
	});

	it("resets to the base delay after recovery succeeds", async () => {
		const current = await setup();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		current.setResponses([transientFailure(), transientFailure(), fauxAssistantMessage("first recovery")]);
		const first = current.session.prompt("first");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(90_000);
		await first;
		expect(current.session.retryAttempt).toBe(0);

		current.setResponses([transientFailure(), fauxAssistantMessage("second recovery")]);
		const second = current.session.prompt("second");
		await vi.advanceTimersByTimeAsync(0);
		expect(current.eventsOfType("auto_retry_start").map(({ attempt, delayMs }) => ({ attempt, delayMs }))).toEqual([
			{ attempt: 1, delayMs: 30_000 },
			{ attempt: 2, delayMs: 60_000 },
			{ attempt: 1, delayMs: 30_000 },
		]);
		await vi.advanceTimersByTimeAsync(30_000);
		await second;
	});

	it.each(["abortRetry", "abort"] as const)("%s cancels capped sleep and resets the next retry", async (method) => {
		const current = await setup();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		current.setResponses(Array.from({ length: 5 }, transientFailure));
		const first = current.session.prompt("first");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(450_000);
		expect(current.eventsOfType("auto_retry_start").at(-1)).toMatchObject({ attempt: 5, delayMs: 300_000 });
		expect(current.session.isRetrying).toBe(true);
		await current.session[method]();
		await first;
		expect(current.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			attempt: 5,
			finalError: "Retry cancelled",
		});
		expect(current.faux.state.callCount).toBe(5);
		expect(current.session.retryAttempt).toBe(0);
		expect(current.session.hasActiveRetry).toBe(false);
		expect(current.session.isRetrying).toBe(false);
		expect(vi.getTimerCount()).toBe(0);

		current.setResponses([transientFailure(), fauxAssistantMessage("recovered")]);
		const second = current.session.prompt("second");
		await vi.advanceTimersByTimeAsync(0);
		expect(current.eventsOfType("auto_retry_start").at(-1)).toMatchObject({ attempt: 1, delayMs: 30_000 });
		await vi.advanceTimersByTimeAsync(30_000);
		await second;
	});

	it("retains thirty retries after the initial request with zero-delay settings", async () => {
		const current = await setup({ baseDelayMs: 0 });
		current.setResponses([...Array.from({ length: 31 }, transientFailure), fauxAssistantMessage("unused")]);
		const prompt = current.session.prompt("test");
		await vi.runAllTimersAsync();
		await prompt;
		expect(current.faux.state.callCount).toBe(31);
		expect(current.getPendingResponseCount()).toBe(1);
		expect(current.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual(
			Array.from({ length: 30 }, (_, index) => index + 1),
		);
		expect(current.eventsOfType("auto_retry_start").every((event) => event.delayMs === 0)).toBe(true);
		expect(current.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: false, attempt: 30 });
		expect(current.session.retryAttempt).toBe(0);
	});
});
