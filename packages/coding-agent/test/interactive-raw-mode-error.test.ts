import { TerminalRawModeError } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runInteractiveActionOrReportTerminalError } from "../src/main.ts";

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

	test("rethrows unrelated startup failures", async () => {
		const unrelatedError = new Error("extension startup failed");

		await expect(
			runInteractiveActionOrReportTerminalError(async () => {
				throw unrelatedError;
			}),
		).rejects.toBe(unrelatedError);
	});
});
