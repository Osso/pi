import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import goalExtension from "../../extensions/goal/src/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

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

describe("goal extension runtime", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("continues a goal from agent_end without another user prompt", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension], uiContext: createUiContext() });
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 9 }, (_, index) => fauxAssistantMessage(`round ${index + 1}`)));

		await harness.session.prompt("/goal say hello twice in two different rounds");
		await waitForProviderCalls(harness, 9);

		expect(harness.faux.state.callCount).toBe(9);
		expect(getUserTexts(harness)).toContain(
			"Continue working toward this objective until it is achieved: say hello twice in two different rounds",
		);
	});

	it("does not let an agent reset an active goal through set_goal", async () => {
		const harness = await createHarness({ extensionFactories: [goalExtension], uiContext: createUiContext() });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("set_goal", { objective: "agent-chosen objective", replace: true }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/goal first objective");
		await waitForProviderCalls(harness, 2);

		const goal = JSON.parse(readFileSync(join(harness.tempDir, ".pi", "goal.json"), "utf8")) as { objective: string };
		expect(goal.objective).toBe("first objective");
	});
});
