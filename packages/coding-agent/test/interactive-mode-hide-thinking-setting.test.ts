import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("Hide thinking setting", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	test("updates the response that is still streaming", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const streamingMessage = fauxAssistantMessage([
			fauxThinking("Private reasoning fixture"),
			fauxText("Partial answer"),
		]);
		const streamingComponent = new AssistantMessageComponent(streamingMessage, false, getMarkdownTheme());
		const transcriptTailContainer = new Container();
		transcriptTailContainer.addChild(streamingComponent);
		let selector: SettingsSelectorComponent | undefined;
		const view = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: harness.session },
			chatContainer: new Container(),
			transcriptTailContainer,
			transcriptTailRegion: { clear: () => {} },
			streamingComponent,
			streamingMessage,
			hideThinkingBlock: false,
			ui: { requestRender: () => {} },
			themeController: { getTerminalTheme: () => "dark" },
			rebuildChatFromMessages: () => {},
			showStatus: () => {},
			showSelector: (create: (done: () => void) => { component: SettingsSelectorComponent }) => {
				selector = create(() => {}).component;
			},
		}) as { showSettingsSelector(): void };
		const tail = () => stripAnsi(transcriptTailContainer.render(80).join("\n"));

		view.showSettingsSelector();
		const list = selector?.getSettingsList();
		list?.handleInput("Hide thinking");
		list?.handleInput("\r");

		expect(harness.settingsManager.getHideThinkingBlock()).toBe(true);
		expect(tail()).not.toContain("Private reasoning fixture");
		expect(tail()).toContain("Partial answer");

		list?.handleInput("\r");
		expect(tail()).toContain("Private reasoning fixture");
	});
});
