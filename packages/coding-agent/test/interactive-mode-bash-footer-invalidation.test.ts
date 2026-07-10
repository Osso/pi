import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type BashResult = {
	output: string;
	exitCode: number;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath: undefined;
};

type HandleBashCommandThis = {
	bashComponent: unknown;
	chatContainer: Container;
	footer: { invalidate(): void };
	pendingBashComponents: unknown[];
	pendingMessagesContainer: Container;
	runtimeHost: {
		session: {
			extensionRunner: { emitUserBash(): Promise<{ result: BashResult } | undefined> };
			isStreaming: boolean;
			recordBashResult(command: string, result: BashResult, options: { excludeFromContext: boolean }): void;
			executeBash(
				command: string,
				onOutput: (chunk: string) => void,
				options: { excludeFromContext: boolean; operations: undefined },
			): Promise<BashResult>;
			sessionManager: { getCwd(): string };
		};
	};
	showError(message: string): void;
	ui: Pick<TUI, "requestRender">;
};

type HandleBashCommand = (this: HandleBashCommandThis, command: string, excludeFromContext?: boolean) => Promise<void>;

const handleBashCommand = (InteractiveMode.prototype as unknown as { handleBashCommand: HandleBashCommand })
	.handleBashCommand;

const RESULT: BashResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	fullOutputPath: undefined,
};

function createHarness(intercepted: boolean): HandleBashCommandThis {
	return Object.assign(Object.create(InteractiveMode.prototype) as HandleBashCommandThis, {
		bashComponent: undefined,
		chatContainer: new Container(),
		footer: { invalidate: vi.fn() },
		pendingBashComponents: [],
		pendingMessagesContainer: new Container(),
		runtimeHost: {
			session: {
				extensionRunner: { emitUserBash: vi.fn(async () => (intercepted ? { result: RESULT } : undefined)) },
				isStreaming: false,
				recordBashResult: vi.fn(),
				executeBash: vi.fn(async () => RESULT),
				sessionManager: { getCwd: () => process.cwd() },
			},
		},
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	});
}

describe("InteractiveMode bash footer invalidation", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it.each([
		{ path: "extension result", intercepted: true },
		{ path: "local execution", intercepted: false },
	])("invalidates cached footer data after a context-recorded $path", async ({ intercepted }) => {
		const fakeThis = createHarness(intercepted);

		await handleBashCommand.call(fakeThis, "echo ok", false);

		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ path: "extension result", intercepted: true },
		{ path: "local execution", intercepted: false },
	])("keeps cached context data for excluded $path", async ({ intercepted }) => {
		const fakeThis = createHarness(intercepted);

		await handleBashCommand.call(fakeThis, "echo ok", true);

		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
	});
});
