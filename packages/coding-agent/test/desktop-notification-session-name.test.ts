import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS } from "../src/core/desktop-notification.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createAskQuestionsToolDefinition } from "../src/core/tools/ask-questions.ts";
import type { ExtensionContext } from "../src/index.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

const KEY = { enter: "\r" };

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal()),
	spawn: mocks.spawn,
}));

const mockedSpawn = vi.mocked(spawn);

function createChildProcess() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter & { setEncoding(encoding: BufferEncoding): void };
	};
	child.stdout = Object.assign(new EventEmitter(), {
		setEncoding: vi.fn<(encoding: BufferEncoding) => void>(),
	});
	return child;
}

function createAskQuestionsContext(keys: string[]): ExtensionContext {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const custom = async <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> => {
		let result: { value: T } | undefined;
		const tui = { requestRender: () => {} } as unknown as TUI;
		const component = await factory(tui, theme, keybindings, (value) => {
			result = { value };
		});
		for (const key of keys) {
			if (result) break;
			component.handleInput?.(key);
		}
		if (!result) throw new Error(`Question panel still open after keys: ${JSON.stringify(keys)}`);
		return result.value;
	};
	return { hasUI: true, mode: "tui", ui: { custom } } as unknown as ExtensionContext;
}

function expectNotification(callIndex: number, title: string, body: string): void {
	const call = mockedSpawn.mock.calls[callIndex];
	expect(call?.[0]).toBe("notify-send");
	expect(call?.[1]).toEqual([
		"--print-id",
		"--app-name=Pi",
		`--expire-time=${PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS}`,
		"--urgency=normal",
		title,
		body,
	]);
}

type ResponseCompleteMethod = {
	notifyResponseComplete(
		this: { closeResponseCompleteNotification(): void; responseCompleteNotification?: { close(): void } },
		event: { willRetry: boolean },
	): void;
};

const notifyResponseComplete = (InteractiveMode.prototype as unknown as ResponseCompleteMethod).notifyResponseComplete;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	mockedSpawn.mockReset();
	mockedSpawn.mockReturnValue(createChildProcess() as ReturnType<typeof spawn>);
});

describe("desktop notification session names", () => {
	it("uses the live session name and a recognizable fallback across notification paths", async () => {
		const harness = await createHarness();
		try {
			new AgentSessionRuntime(harness.session, {} as AgentSessionServices, async () => {
				throw new Error("Unexpected session replacement");
			});
			harness.session.setSessionName("Bug Hunt");

			const responseContext = { closeResponseCompleteNotification: vi.fn() };
			notifyResponseComplete.call(responseContext, { willRetry: false });
			expectNotification(0, "Bug Hunt: Pi response complete", "Pi is idle and ready for your next message.");

			const tool = createAskQuestionsToolDefinition();
			const askQuestion = async (callId: string) =>
				tool.execute(
					callId,
					{ blocking: true, questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
					undefined,
					undefined,
					createAskQuestionsContext([KEY.enter]),
				);
			await askQuestion("named-question");
			expectNotification(1, "Bug Hunt: Pi question needs input", "Pi is waiting for your answer.");

			harness.session.setSessionName("Renamed Hunt");
			await askQuestion("renamed-question");
			expectNotification(2, "Renamed Hunt: Pi question needs input", "Pi is waiting for your answer.");

			harness.session.setSessionName(undefined);
			await askQuestion("unnamed-question");
			const sessionId = harness.session.sessionId;
			const cwdName = basename(harness.session.sessionManager.getCwd());
			expectNotification(
				3,
				`${cwdName} (${sessionId.slice(0, 8)}): Pi question needs input`,
				"Pi is waiting for your answer.",
			);
		} finally {
			harness.cleanup();
		}
	});
});
