import { describe, expect, it, vi } from "vitest";
import { normalizeBuiltinSlashCommandSeparator } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { setText: (text: string) => void };
	closeResponseCompleteNotification: () => void;
	addSubmittedTextToHistory: (text: string) => void;
	handleNameCommand: (text: string) => void;
	handleCompactCommand: (customInstructions?: string) => Promise<void>;
	showError: (message: string) => void;
};

function createSubmitContext(): SubmitContext {
	const context: SubmitContext = {
		defaultEditor: {},
		editor: { setText: vi.fn() },
		closeResponseCompleteNotification: vi.fn(),
		addSubmittedTextToHistory: vi.fn(),
		handleNameCommand: vi.fn(),
		handleCompactCommand: vi.fn(async () => {}),
		showError: vi.fn(),
	};
	(
		InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: SubmitContext): void }
	).setupEditorSubmitHandler.call(context);
	return context;
}

async function submit(context: SubmitContext, text: string): Promise<void> {
	const onSubmit = context.defaultEditor.onSubmit;
	if (!onSubmit) throw new Error("submit handler was not installed");
	await onSubmit(text);
	await vi.waitFor(() => expect(context.editor.setText).toHaveBeenCalledWith(""));
}

describe("InteractiveMode built-in command separators", () => {
	it.each(["\n", "\t"])("runs /name when a %j separates the arguments", async (separator) => {
		const context = createSubmitContext();

		await submit(context, `/name${separator}Release notes`);

		expect(context.handleNameCommand).toHaveBeenCalledWith("/name Release notes");
		expect(context.addSubmittedTextToHistory).toHaveBeenCalledWith(`/name${separator}Release notes`);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("runs /compact with multiline instructions after a newline separator", async () => {
		const context = createSubmitContext();

		await submit(context, "/compact\nKeep decisions\nDrop logs");

		expect(context.handleCompactCommand).toHaveBeenCalledWith("Keep decisions\nDrop logs");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("leaves other slash-prefixed text unchanged", () => {
		expect(normalizeBuiltinSlashCommandSeparator("/tmp/report.txt\nexplain this")).toBe(
			"/tmp/report.txt\nexplain this",
		);
		expect(normalizeBuiltinSlashCommandSeparator("/example\targs")).toBe("/example\targs");
	});
});
