import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../extensions/goal/src/index.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

function goalTestExtension(pi: ExtensionAPI): void {
	goalExtension(pi, {
		reviewGoal: async ({ payload }) => ({
			instructions: `Continue working toward this objective until it is achieved: ${String(payload.objective)}`,
			kind: "continue",
			reason: "test continuation",
		}),
	});
}

function readStoredGoal(harness: Harness): { objective: string; pausedAt?: string } {
	const goalJson = harness.sessionManager.getSessionGoalJson();
	if (!goalJson) throw new Error("No stored goal");
	return JSON.parse(goalJson) as { objective: string };
}

function createUiContext(): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setDefaultFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

async function waitForProviderCalls(harness: Harness, expectedCallCount: number): Promise<void> {
	const deadline = Date.now() + 1000;
	while (harness.faux.state.callCount < expectedCallCount && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function waitForStoredGoalObjective(harness: Harness, objective: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (readStoredGoal(harness).objective === objective) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("goal extension runtime", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("continues a goal from agent_end without another user prompt", async () => {
		const harness = await createHarness({ extensionFactories: [goalTestExtension], uiContext: createUiContext() });
		harnesses.push(harness);
		harness.setResponses([
			...Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`round ${index + 1}`)),
			fauxAssistantMessage("   "),
		]);

		await harness.session.prompt("/goal set say hello twice in two different rounds");
		await waitForProviderCalls(harness, 9);

		expect(harness.faux.state.callCount).toBe(9);
		expect(JSON.stringify(harness.session.messages)).toContain(
			"Continue working toward this objective until it is achieved: say hello twice in two different rounds",
		);
	});

	it("reports one skipped status only after retryable errors are exhausted", async () => {
		const pauseAfterRetry = (pi: ExtensionAPI): void => {
			goalExtension(pi, { reviewGoal: async () => ({ kind: "pause", reason: "test complete" }) });
		};
		const harness = await createHarness({
			extensionFactories: [pauseAfterRetry],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			uiContext: createUiContext(),
		});
		harnesses.push(harness);
		harness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "survive retries", branch: "test", createdAt: new Date().toISOString() }),
		);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("retry work");
		await new Promise((resolve) => setTimeout(resolve, 20));

		const skippedStatuses = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "supervisor-status" &&
					JSON.stringify(entry.data).includes("Goal continuation skipped: the model turn ended with an error."),
			);
		expect(harness.faux.state.callCount).toBe(3);
		expect(skippedStatuses).toHaveLength(1);
	});

	it("reports a skipped goal continuation when retry sleep is canceled", async () => {
		const harness = await createHarness({
			extensionFactories: [goalTestExtension],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } },
			uiContext: createUiContext(),
		});
		harnesses.push(harness);
		harness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "survive cancellation", branch: "test", createdAt: new Date().toISOString() }),
		);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const retryStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "auto_retry_start") return;
				unsubscribe();
				resolve();
			});
		});

		const prompt = harness.session.prompt("retry work");
		await retryStarted;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "supervisor-status"),
		).toHaveLength(0);
		harness.session.abortRetry();
		await prompt;
		await new Promise((resolve) => setTimeout(resolve, 120));

		const skippedStatuses = harness.sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "supervisor-status" &&
					JSON.stringify(entry.data).includes("Goal continuation skipped: the model turn ended with an error."),
			);
		expect(skippedStatuses).toHaveLength(1);
	});

	it("waits for an actual delayed agent_end listener before reporting an error", async () => {
		let releaseListener: (() => void) | undefined;
		const listenerReleased = new Promise<void>((resolve) => {
			releaseListener = resolve;
		});
		const delayedListener = (pi: ExtensionAPI): void => {
			pi.on("agent_end", async () => listenerReleased);
		};
		const harness = await createHarness({
			extensionFactories: [goalTestExtension, delayedListener],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			uiContext: createUiContext(),
		});
		harnesses.push(harness);
		harness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "wait for listeners", branch: "test", createdAt: new Date().toISOString() }),
		);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		const prompt = harness.session.prompt("initial work");
		await waitForProviderCalls(harness, 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.sessionManager.getEntries()).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "supervisor-status" })]),
		);
		releaseListener?.();
		await prompt;
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "supervisor-status" })]),
		);
	});

	it("cancels an empty-response retry when interactive input arrives before expiry", async () => {
		vi.useFakeTimers();
		const stopAfterInteractiveInput = (pi: ExtensionAPI): void => {
			goalExtension(pi, { reviewGoal: async () => ({ kind: "pause", reason: "test complete" }) });
		};
		const harness = await createHarness({
			extensionFactories: [stopAfterInteractiveInput],
			uiContext: createUiContext(),
		});
		harnesses.push(harness);
		harness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "keep going", branch: "test", createdAt: new Date().toISOString() }),
		);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "stop" }),
			fauxAssistantMessage("interactive response"),
			fauxAssistantMessage("stale timer continuation"),
		]);

		await harness.session.prompt("initial work");
		expect(harness.faux.state.callCount).toBe(1);

		await vi.advanceTimersByTimeAsync(999);
		await harness.session.prompt("interactive input");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["initial work", "interactive input"]);

		await vi.advanceTimersByTimeAsync(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("keeps a goal running when interactive replacement input aborts the active turn", async () => {
		const harness = await createHarness({ extensionFactories: [goalTestExtension], uiContext: createUiContext() });
		harnesses.push(harness);
		let markRequestStarted: (() => void) | undefined;
		const requestStarted = new Promise<void>((resolve) => {
			markRequestStarted = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				markRequestStarted?.();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("Interrupted", { stopReason: "aborted" });
			},
			fauxAssistantMessage("queued user prompt"),
		]);
		harness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "keep going", branch: "test", createdAt: new Date().toISOString() }),
		);

		const activePrompt = harness.session.prompt("initial goal work");
		await requestStarted;
		await harness.session.interrupt("queued after escape");
		await activePrompt;

		expect(harness.faux.state.callCount).toBeGreaterThanOrEqual(2);
		expect(getUserTexts(harness)).toEqual(expect.arrayContaining(["initial goal work", "queued after escape"]));
		expect(readStoredGoal(harness).pausedAt).toBeUndefined();
	});

	it("does not let a continuation turn replace the active goal with continue", async () => {
		const harness = await createHarness({ extensionFactories: [goalTestExtension], uiContext: createUiContext() });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("manage_goal", { action: "set", objective: "continue" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("still working"),
		]);

		await harness.session.prompt("/goal set keep the original objective");
		await waitForProviderCalls(harness, 2);

		expect(readStoredGoal(harness).objective).toBe("keep the original objective");
	});

	it("lets an agent reset an active goal through manage_goal", async () => {
		const harness = await createHarness({ extensionFactories: [goalTestExtension], uiContext: createUiContext() });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("manage_goal", { action: "set", objective: "agent-chosen objective" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/goal set first objective");
		await waitForProviderCalls(harness, 2);
		await waitForStoredGoalObjective(harness, "agent-chosen objective");

		const goal = readStoredGoal(harness);
		expect(goal.objective).toBe("agent-chosen objective");
	});
});
