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
	handleBashCommand: (command: string, excludeFromContext: boolean) => Promise<void>;
	handleDebugCommand: () => void;
	isBashMode: boolean;
	multiAgentStore?: {
		getAgent: (agentId: string) =>
			| {
					displayName: string;
					id: string;
					lifecycle: string;
					parentId: string;
					transcript: { sessionId: string };
			  }
			| undefined;
		getSelectedAgentId: () => string | undefined;
	};
	onInputCallback?: (text: string) => void;
	options: {
		steerMultiAgent?: (agentId: string, message: string) => Promise<{ ok: boolean; error?: string }>;
		wakeWaitAgentsAfterSteering?: () => void;
	};
	pendingUserInputs: string[];
	showError: (message: string) => void;
	showSettingsSelector: () => void;
	submitSelectedAgentSteering(this: SubmitContext, message: string, submittedText?: string): Promise<boolean>;
	ui: { requestRender: () => void };
	updateEditorBorderColor: () => void;
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
	submitSelectedAgentSteering(this: SubmitContext, message: string, submittedText?: string): Promise<boolean>;
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
		handleBashCommand: vi.fn(async () => {}),
		handleDebugCommand: vi.fn(),
		isBashMode: false,
		options: {},
		pendingUserInputs: [],
		showError: vi.fn(),
		showSettingsSelector: vi.fn(),
		submitSelectedAgentSteering: interactiveModePrototype.submitSelectedAgentSteering,
		ui: { requestRender: vi.fn() },
		updateEditorBorderColor: vi.fn(),
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

	it("steers the selected active child instead of submitting plain text to the main thread", async () => {
		const context = createSubmitContext();
		const steerMultiAgent = vi.fn(async () => ({ ok: true }));
		context.multiAgentStore = {
			getAgent: () => ({
				displayName: "worker",
				id: "agent_1",
				lifecycle: "running",
				parentId: "main",
				transcript: { sessionId: "child-session" },
			}),
			getSelectedAgentId: () => "agent_1",
		};
		context.options.steerMultiAgent = steerMultiAgent;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" redirect this child ");

		expect(steerMultiAgent).toHaveBeenCalledWith("agent_1", "redirect this child");
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.editor.addToHistory).toHaveBeenCalledWith("redirect this child");
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("preserves exact editor text when selected-child steering is rejected", async () => {
		const context = createSubmitContext();
		context.multiAgentStore = {
			getAgent: () => ({
				displayName: "worker",
				id: "agent_1",
				lifecycle: "running",
				parentId: "main",
				transcript: { sessionId: "child-session" },
			}),
			getSelectedAgentId: () => "agent_1",
		};
		context.options.steerMultiAgent = vi.fn(async () => ({ error: "child became terminal", ok: false }));
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("  redirect this child  ");

		expect(context.editor.setText).toHaveBeenCalledWith("  redirect this child  ");
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith("child became terminal");
	});

	it("does not fall back to the main thread when the selected agent is not steerable", async () => {
		const context = createSubmitContext();
		context.multiAgentStore = {
			getAgent: () => ({
				displayName: "grandchild",
				id: "agent_2",
				lifecycle: "running",
				parentId: "agent_1",
				transcript: { sessionId: "grandchild-session" },
			}),
			getSelectedAgentId: () => "agent_2",
		};
		context.options.steerMultiAgent = vi.fn(async () => ({ ok: true }));
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("keep this scoped");

		expect(context.options.steerMultiAgent).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.editor.setText).toHaveBeenCalledWith("keep this scoped");
		expect(context.showError).toHaveBeenCalledWith("Could not steer grandchild: agent is not steerable");
	});

	it("keeps slash commands on the main thread while a child is selected", async () => {
		const context = createSubmitContext();
		const steerMultiAgent = vi.fn(async () => ({ ok: true }));
		context.multiAgentStore = {
			getAgent: () => ({
				displayName: "worker",
				id: "agent_1",
				lifecycle: "running",
				parentId: "main",
				transcript: { sessionId: "child-session" },
			}),
			getSelectedAgentId: () => "agent_1",
		};
		context.options.steerMultiAgent = steerMultiAgent;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /settings ");

		expect(steerMultiAgent).not.toHaveBeenCalled();
		expect(context.editor.addToHistory).toHaveBeenCalledWith("/settings");
		expect(context.showSettingsSelector).toHaveBeenCalledTimes(1);
		expect(context.editor.setText).toHaveBeenCalledWith("");
	});

	it("keeps shell commands on the main thread while a child is selected", async () => {
		const context = createSubmitContext();
		const steerMultiAgent = vi.fn(async () => ({ ok: true }));
		context.multiAgentStore = {
			getAgent: () => ({
				displayName: "worker",
				id: "agent_1",
				lifecycle: "running",
				parentId: "main",
				transcript: { sessionId: "child-session" },
			}),
			getSelectedAgentId: () => "agent_1",
		};
		context.options.steerMultiAgent = steerMultiAgent;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" ! pwd ");

		expect(steerMultiAgent).not.toHaveBeenCalled();
		expect(context.handleBashCommand).toHaveBeenCalledWith("pwd", false);
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("dispatches /debug through the registered extension command", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /debug ");

		expect(context.pendingUserInputs).toEqual(["/debug"]);
		expect(context.handleDebugCommand).not.toHaveBeenCalled();
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

	it("wakes wait_agents only after ordinary streaming steering is accepted", async () => {
		let acceptPrompt: (() => void) | undefined;
		const promptAccepted = new Promise<void>((resolve) => {
			acceptPrompt = resolve;
		});
		const context = createSubmitContext();
		context.session.isStreaming = true;
		context.session.prompt = vi.fn(() => promptAccepted);
		context.options.wakeWaitAgentsAfterSteering = vi.fn();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const submission = context.defaultEditor.onSubmit?.("test");
		await Promise.resolve();
		expect(context.session.prompt).toHaveBeenCalledWith("test", { streamingBehavior: "steer" });
		expect(context.options.wakeWaitAgentsAfterSteering).not.toHaveBeenCalled();

		acceptPrompt?.();
		await submission;
		expect(context.options.wakeWaitAgentsAfterSteering).toHaveBeenCalledOnce();
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
