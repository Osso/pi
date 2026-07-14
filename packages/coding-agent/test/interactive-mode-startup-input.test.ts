import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimLatestIncomingMessage,
	enqueueIncomingMessage,
	getControlDbPath,
	readIncomingMessageStatus,
} from "../src/core/session-control-db.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		continue: () => Promise<void>;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	cancelStreamingAndSubmitQueuedMessages: () => Promise<void>;
	closeResponseCompleteNotification: () => void;
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	showSettingsSelector: () => void;
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type MainLoopContext = {
	session: { prompt: (text: string, options?: unknown) => Promise<void> };
	clipboardTempFiles: { cleanupReferencedIn: (text: string) => void };
	showError: (text: string) => void;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	submitMainLoopInput(this: MainLoopContext, userInput: string): Promise<void>;
	processControlMessage(
		this: ControlMessageContext,
		message: { id: number; content: string } | undefined,
		controlDbPath?: string,
	): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

type ControlMessageContext = {
	session: {
		prompt: (text: string) => Promise<void>;
	};
	showError: (text: string) => void;
};

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			continue: vi.fn(async () => {}),
			prompt: vi.fn(async () => {}),
		},
		cancelStreamingAndSubmitQueuedMessages: vi.fn(async () => {}),
		closeResponseCompleteNotification: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [],
		showSettingsSelector: vi.fn(),
	};
}

describe("InteractiveMode startup input", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-interactive-control-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.closeResponseCompleteNotification).toHaveBeenCalledTimes(1);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("records built-in slash commands in prompt history", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /settings ");

		expect(context.editor.addToHistory).toHaveBeenCalledWith("/settings");
		expect(context.showSettingsSelector).toHaveBeenCalledTimes(1);
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("continues the current transcript without submitting a user message", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /continue ");

		expect(context.editor.addToHistory).toHaveBeenCalledWith("/continue");
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.session.continue).toHaveBeenCalledTimes(1);
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("submits queued and current messages for /continue while streaming", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /continue ");

		expect(context.editor.addToHistory).toHaveBeenCalledWith("/continue");
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.cancelStreamingAndSubmitQueuedMessages).toHaveBeenCalledTimes(1);
		expect(context.session.continue).not.toHaveBeenCalled();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("queues main-loop input as steering when a background turn raced in", async () => {
		// Regression: after Escape resubmits queued steering text, a runtime
		// mailbox delivery can start a new turn first. The main loop must queue
		// the text as steering instead of losing it to an "already processing" error.
		const context: MainLoopContext = {
			session: { prompt: vi.fn(async () => {}) },
			clipboardTempFiles: { cleanupReferencedIn: vi.fn() },
			showError: vi.fn(),
		};

		await interactiveModePrototype.submitMainLoopInput.call(context, "queued steering");

		expect(context.session.prompt).toHaveBeenCalledWith("queued steering", { streamingBehavior: "steer" });
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("submits and completes a claimed control message on startup", async () => {
		enqueueIncomingMessage(controlDbPath, "harness prompt");
		const message = claimLatestIncomingMessage(controlDbPath);
		const context: ControlMessageContext = {
			session: {
				prompt: vi.fn(async () => {}),
			},
			showError: vi.fn(),
		};

		await interactiveModePrototype.processControlMessage.call(context, message, controlDbPath);

		expect(context.session.prompt).toHaveBeenCalledWith("harness prompt");
		expect(readIncomingMessageStatus(controlDbPath, message!.id)).toBe("completed");
		expect(context.showError).not.toHaveBeenCalled();
	});
});
