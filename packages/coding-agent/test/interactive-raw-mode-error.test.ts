import { TerminalRawModeError } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runInteractiveActionOrReportTerminalError } from "../src/main.ts";
import { showDeprecationWarnings } from "../src/migrations.ts";

describe("interactive raw mode startup errors", () => {
	const previousExitCode = process.exitCode;

	afterEach(() => {
		process.exitCode = previousExitCode;
		vi.restoreAllMocks();
	});

	test("reports raw mode failures without rethrowing Bun internals", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handled = await runInteractiveActionOrReportTerminalError(async () => {
			throw new TerminalRawModeError(true, new Error("setRawMode failed with errno: 5"));
		});

		expect(handled).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to enable terminal raw mode"));
	});

	test("runs terminal-error cleanup when raw mode startup fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const cleanup = vi.fn();

		const handled = await runInteractiveActionOrReportTerminalError(async () => {
			throw new TerminalRawModeError(true, new Error("setRawMode failed with errno: 5"));
		}, cleanup);

		expect(handled).toBe(false);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to enable terminal raw mode"));
	});

	test("reports plain raw mode errno errors without rethrowing", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const handled = await runInteractiveActionOrReportTerminalError(async () => {
			throw new Error("setRawMode failed with errno: 5");
		});

		expect(handled).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("setRawMode failed with errno: 5"));
	});

	test("rethrows unrelated startup failures", async () => {
		const unrelatedError = new Error("extension startup failed");

		await expect(
			runInteractiveActionOrReportTerminalError(async () => {
				throw unrelatedError;
			}),
		).rejects.toBe(unrelatedError);
	});
});

describe("migration raw mode warnings", () => {
	const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const previousSetRawMode = process.stdin.setRawMode;

	afterEach(() => {
		if (previousIsTTYDescriptor) {
			Object.defineProperty(process.stdin, "isTTY", previousIsTTYDescriptor);
		} else {
			Reflect.deleteProperty(process.stdin, "isTTY");
		}
		process.stdin.setRawMode = previousSetRawMode;
		vi.restoreAllMocks();
	});

	test("warns and skips keypress wait when raw mode fails", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		process.stdin.setRawMode = vi.fn(() => {
			throw new Error("setRawMode failed with errno: 5");
		}) as typeof process.stdin.setRawMode;

		await showDeprecationWarnings(["legacy hooks/ directory found"]);

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("setRawMode failed with errno: 5"));
	});

	test("skips raw-mode keypress prompt when stdin is not a TTY", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const setRawMode = vi.fn(() => {
			throw new Error("setRawMode should not be called");
		});
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		process.stdin.setRawMode = setRawMode as typeof process.stdin.setRawMode;

		await showDeprecationWarnings(["legacy hooks/ directory found"]);

		expect(setRawMode).not.toHaveBeenCalled();
	});
});
