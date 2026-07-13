import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ResumeContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	runtimeHost: {
		session: {
			messages: Array<{ role: string }>;
			continue: () => Promise<void>;
			modelRegistry: { getError: () => string | undefined };
			prompt: (text: string) => Promise<void>;
		};
		switchSession: (
			sessionPath: string,
			options: { projectTrustContextFactory: (cwd: string) => unknown; withSession?: unknown },
		) => Promise<{ cancelled: boolean }>;
	};
	session: {
		messages: Array<{ role: string }>;
		continue: () => Promise<void>;
		modelRegistry: { getError: () => string | undefined };
		prompt: (text: string) => Promise<void>;
	};
	createProjectTrustContext: (cwd: string) => unknown;
	showStatus: (message: string) => void;
	handleFatalRuntimeError: (message: string, error: unknown) => { cancelled: boolean };
};

type StartupContext = ResumeContext & {
	options: Record<string, undefined>;
	init: () => Promise<void>;
	checkTmuxKeyboardSetup: () => Promise<string | undefined>;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	processControlMessage: () => Promise<void>;
	getUserInput: () => Promise<string>;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	run(this: StartupContext): Promise<void>;
	handleResumeSession(this: ResumeContext, sessionPath: string): Promise<{ cancelled: boolean }>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createResumeContext(lastRole: string): ResumeContext {
	return Object.assign(Object.create(interactiveModePrototype), {
		statusContainer: { clear: vi.fn() },
		runtimeHost: {
			session: {
				messages: [{ role: lastRole }],
				continue: vi.fn(async () => {}),
				modelRegistry: { getError: () => undefined },
				prompt: vi.fn(async () => {}),
			},
			switchSession: vi.fn(async () => ({ cancelled: false })),
		},
		createProjectTrustContext: vi.fn(() => ({})),
		showStatus: vi.fn(),
		handleFatalRuntimeError: vi.fn(() => ({ cancelled: true })),
	}) as ResumeContext;
}

describe("InteractiveMode session resume continuation", () => {
	it("continues an interrupted transcript during startup resume", async () => {
		const stopLoop = new Error("stop interactive loop");
		const context = Object.assign(createResumeContext("toolResult"), {
			options: {},
			init: vi.fn(async () => {}),
			checkTmuxKeyboardSetup: vi.fn(async () => undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
			processControlMessage: vi.fn(async () => {}),
			getUserInput: vi.fn(async () => {
				throw stopLoop;
			}),
			showWarning: vi.fn(),
			showError: vi.fn(),
		}) as StartupContext;

		await expect(interactiveModePrototype.run.call(context)).rejects.toBe(stopLoop);

		expect(context.session.continue).toHaveBeenCalledTimes(1);
	});

	it("continues a resumed transcript that ends with a tool result", async () => {
		const context = createResumeContext("toolResult");

		await interactiveModePrototype.handleResumeSession.call(context, "/tmp/interrupted.jsonl");

		expect(context.session.continue).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");
	});

	it("does not continue a resumed transcript with a completed assistant turn", async () => {
		const context = createResumeContext("assistant");

		await interactiveModePrototype.handleResumeSession.call(context, "/tmp/completed.jsonl");

		expect(context.session.continue).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Resumed session");
	});
});
