import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type SignalHandler = () => void;

interface SignalContext {
	signalCleanupHandlers: Array<() => void>;
	unregisterSignalHandlers: () => void;
	restartProcess: (options?: { fromSignal?: boolean; notice?: string }) => Promise<void>;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
}

interface InteractiveModeSignals {
	registerSignalHandlers(this: SignalContext): void;
	restartProcess(
		this: {
			runtimeHost: { restart: (options: { notice?: string; process: boolean }) => Promise<void> };
			themeController: { disableAutoSync: () => void };
		},
		options?: { fromSignal?: boolean; notice?: string },
	): Promise<void>;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModeSignals;

describe("InteractiveMode SIGHUP restart harness", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("routes process restart through runtime teardown", async () => {
		const restart = vi.fn(async () => {});
		const disableAutoSync = vi.fn();

		await interactiveModePrototype.restartProcess.call(
			{ runtimeHost: { restart }, themeController: { disableAutoSync } },
			{ fromSignal: true, notice: "Restarted." },
		);

		expect(disableAutoSync).toHaveBeenCalledTimes(1);
		expect(restart).toHaveBeenCalledWith({ notice: "Restarted.", process: true });
	});

	test("routes SIGHUP to self-restart while SIGTERM still shuts down", async () => {
		const handlers = new Map<NodeJS.Signals, SignalHandler>();
		vi.spyOn(process, "prependListener").mockImplementation(((eventName: string | symbol, listener: unknown) => {
			const signal = String(eventName);
			if (signal === "SIGHUP" || signal === "SIGTERM") {
				handlers.set(signal, listener as SignalHandler);
			}
			return process;
		}) as typeof process.prependListener);
		vi.spyOn(process.stdout, "on").mockReturnValue(process.stdout);
		vi.spyOn(process.stderr, "on").mockReturnValue(process.stderr);

		const context: SignalContext = {
			restartProcess: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			signalCleanupHandlers: [],
			unregisterSignalHandlers: vi.fn(),
		};

		interactiveModePrototype.registerSignalHandlers.call(context);
		handlers.get("SIGHUP")?.();
		handlers.get("SIGTERM")?.();
		await Promise.resolve();

		expect(context.restartProcess).toHaveBeenCalledTimes(1);
		expect(context.restartProcess).toHaveBeenCalledWith({ fromSignal: true });
		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});
});
