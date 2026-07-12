import type { UserMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

interface InteractiveModeInternals {
	addMessageToChat(message: UserMessage, options?: { populateHistory?: boolean }): void;
}

const interactiveMode = InteractiveMode.prototype as unknown as InteractiveModeInternals;

beforeAll(() => {
	initTheme("dark");
});

describe("goal system prompt history", () => {
	it("does not add extension-origin user messages to editor history", () => {
		const addRenderedMessageToEditorHistory = vi.fn();
		const fakeThis = {
			addRenderedMessageToEditorHistory,
			chatContainer: new Container(),
			getMarkdownThemeWithSettings: () => ({}),
			getUserMessageText: (message: UserMessage) =>
				typeof message.content === "string"
					? message.content
					: message.content[0]?.type === "text"
						? message.content[0].text
						: "",
		};
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Continue working toward this objective until it is achieved: fix history" }],
			inputSource: "extension",
			timestamp: Date.now(),
		};

		interactiveMode.addMessageToChat.call(fakeThis, message, { populateHistory: true });

		expect(addRenderedMessageToEditorHistory).not.toHaveBeenCalled();
	});
});
