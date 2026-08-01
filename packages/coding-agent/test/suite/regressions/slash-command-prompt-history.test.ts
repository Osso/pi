import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { PromptTemplate } from "../../../src/core/prompt-templates.ts";
import { recordPromptHistoryEntry } from "../../../src/core/session-control-db.ts";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { CustomEditor, type CustomEditorOptions } from "../../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText } from "../harness.ts";

interface SubmitContext {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	closeResponseCompleteNotification: () => void;
	addSubmittedTextToHistory(text: string): void;
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	session: {
		isBashRunning: boolean;
		isCompacting: boolean;
		isStreaming: boolean;
		promptTemplates: ReadonlyArray<PromptTemplate>;
	};
}

interface InteractiveModeInternals {
	addMessageToChat(message: UserMessage, options?: { populateHistory?: boolean }): void;
	addSubmittedTextToHistory(this: SubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
}

type FilterableEditorOptions = CustomEditorOptions & {
	promptHistoryFilter: (text: string) => boolean;
};

const SHIP_SKILL_CONTENT = `<skill name="ship" location="/virtual/ship/SKILL.md">
References are relative to /virtual/ship.

# Ship Feature Branch
</skill>`;

const shipTemplate: PromptTemplate = {
	name: "ship",
	description: "Ship feature branch",
	content: SHIP_SKILL_CONTENT,
	filePath: "/virtual/ship.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/ship.md", {
		source: "local",
		scope: "temporary",
		origin: "top-level",
	}),
};

const interactiveMode = InteractiveMode.prototype as unknown as InteractiveModeInternals;

beforeAll(() => {
	initTheme("dark");
});

describe("slash command prompt history", () => {
	it.each(["/ship", "/skill:ship"])("does not record skill invocation %s when submitted", async (command) => {
		const addToHistory = vi.fn();
		const onInputCallback = vi.fn();
		const context: SubmitContext = {
			defaultEditor: {},
			editor: {
				addToHistory,
				setText: vi.fn(),
			},
			addSubmittedTextToHistory: interactiveMode.addSubmittedTextToHistory,
			closeResponseCompleteNotification: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			onInputCallback,
			pendingUserInputs: [],
			session: {
				isBashRunning: false,
				isCompacting: false,
				isStreaming: false,
				promptTemplates: [shipTemplate],
			},
		};
		interactiveMode.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(command);

		expect(onInputCallback).toHaveBeenCalledWith(command);
		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("filters preexisting skill invocations when loading persisted history", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-skill-history-"));
		const controlDbPath = join(tempDir, "control.sqlite");

		try {
			recordPromptHistoryEntry(controlDbPath, "normal prompt");
			recordPromptHistoryEntry(controlDbPath, "/ship");
			recordPromptHistoryEntry(
				controlDbPath,
				`<skill name="ship" location="/virtual/ship/SKILL.md">
# Ship Feature Branch
</skill>`,
			);
			const options: FilterableEditorOptions = {
				promptHistoryControlDbPath: controlDbPath,
				promptHistoryFilter: (text) => text === "normal prompt",
			};
			const editor = new CustomEditor(
				new TUI(new VirtualTerminal()),
				defaultEditorTheme,
				KeybindingsManager.create(),
				options,
			);

			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("normal prompt");
			editor.handleInput("\x1b[A");
			expect(editor.getText()).toBe("normal prompt");
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("does not restore expanded skill content from a persisted session", async () => {
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [shipTemplate], diagnostics: [] }),
		};
		const harness = await createHarness({ persistedSession: true, resourceLoader });

		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("/ship");

			const userEntry = harness.sessionManager
				.getEntries()
				.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user");
			expect(userEntry).toBeDefined();
			if (!userEntry || userEntry.message.role !== "user") {
				throw new Error("Expected persisted user message");
			}
			expect(getMessageText(userEntry.message)).toContain('<skill name="ship"');

			const addRenderedMessageToEditorHistory = vi.fn();
			const fakeThis = {
				addRenderedMessageToEditorHistory,
				chatContainer: new Container(),
				getMarkdownThemeWithSettings: () => ({}),
				getUserMessageText: (message: UserMessage) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
				toolOutputExpanded: false,
			};

			interactiveMode.addMessageToChat.call(fakeThis, userEntry.message, { populateHistory: true });

			expect(addRenderedMessageToEditorHistory).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});
});
