import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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
		expect(getUserTexts(harness)).toContain(
			"Continue working toward this objective until it is achieved: say hello twice in two different rounds",
		);
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
