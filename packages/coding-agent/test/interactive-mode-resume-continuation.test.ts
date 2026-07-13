import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ResumeContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	runtimeHost: {
		session: {
			messages: Array<{ role: string }>;
			continue: () => Promise<void>;
		};
		switchSession: (
			sessionPath: string,
			options: { projectTrustContextFactory: (cwd: string) => unknown; withSession?: unknown },
		) => Promise<{ cancelled: boolean }>;
	};
	session: {
		messages: Array<{ role: string }>;
		continue: () => Promise<void>;
	};
	createProjectTrustContext: (cwd: string) => unknown;
	showStatus: (message: string) => void;
	handleFatalRuntimeError: (message: string, error: unknown) => { cancelled: boolean };
};

type InteractiveModePrivate = {
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
			},
			switchSession: vi.fn(async () => ({ cancelled: false })),
		},
		createProjectTrustContext: vi.fn(() => ({})),
		showStatus: vi.fn(),
		handleFatalRuntimeError: vi.fn(() => ({ cancelled: true })),
	}) as ResumeContext;
}

describe("InteractiveMode session resume continuation", () => {
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
