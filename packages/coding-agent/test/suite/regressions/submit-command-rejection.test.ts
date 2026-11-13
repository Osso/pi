import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// The editor drops the promise returned by onSubmit. A command that rejected, such as /continue without
// credentials, became an unhandled rejection and the uncaughtException handler exited Pi.

interface SubmitContext {
	defaultEditor: { onSubmit?: (text: string) => unknown };
	editor: { setText: (text: string) => void };
	closeResponseCompleteNotification: () => void;
	addSubmittedTextToHistory: (text: string) => void;
	showError: (message: string) => void;
	session: { isStreaming: boolean; continue: () => Promise<void> };
}

interface InteractiveModeInternals {
	setupEditorSubmitHandler(this: SubmitContext): void;
}

const interactiveMode = InteractiveMode.prototype as unknown as InteractiveModeInternals;

describe("interactive submit command rejection", () => {
	it("reports a rejected /continue in the chat instead of leaving an unhandled rejection", async () => {
		const authError = new Error(
			"Authentication failed for \"openai-codex\". Run '/login openai-codex' to re-authenticate.",
		);
		const showError = vi.fn();
		const context: SubmitContext = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			closeResponseCompleteNotification: vi.fn(),
			addSubmittedTextToHistory: vi.fn(),
			showError,
			session: { isStreaming: false, continue: vi.fn(async () => Promise.reject(authError)) },
		};
		interactiveMode.setupEditorSubmitHandler.call(context);

		await expect(context.defaultEditor.onSubmit?.("/continue")).resolves.toBeUndefined();

		expect(context.session.continue).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith(authError.message);
	});
});
