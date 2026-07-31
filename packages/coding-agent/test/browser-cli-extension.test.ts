import { describe, expect, it, vi } from "vitest";
import { type BrowserCliCommandRunner, createBrowserCliToolDefinition } from "../extensions/browser-cli/src/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

describe("browser-cli extension", () => {
	it("runs browser-cli argv, returns stdout, and reports nonzero exits", async () => {
		const runCommand = vi
			.fn<BrowserCliCommandRunner>()
			.mockResolvedValueOnce({ stdout: "Google\n", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ stdout: "", stderr: "denied", exitCode: 7 });
		const tool = createBrowserCliToolDefinition({ runCommand });

		const result = await tool.execute(
			"call-1",
			{ args: ["get", "title"] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(runCommand).toHaveBeenNthCalledWith(1, "browser-cli", ["get", "title"], undefined);
		expect(result.content).toEqual([{ type: "text", text: "Google\n" }]);

		await expect(
			tool.execute("call-2", { args: ["click", "#search"] }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/browser-cli.*7/);
		expect(runCommand).toHaveBeenNthCalledWith(2, "browser-cli", ["click", "#search"], undefined);
	});

	it("rejects a running command when its signal is aborted", async () => {
		const runCommand = vi.fn<BrowserCliCommandRunner>().mockImplementation(async (_executable, _args, signal) => {
			await new Promise<void>((resolve) => {
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { stdout: "late", stderr: "", exitCode: 0 };
		});
		const tool = createBrowserCliToolDefinition({ runCommand });
		const controller = new AbortController();
		const execution = tool.execute(
			"call-3",
			{ args: ["wait", "1000"] },
			controller.signal,
			undefined,
			{} as ExtensionContext,
		);

		controller.abort();

		await expect(execution).rejects.toThrow(/browser-cli command aborted/);
		expect(runCommand).toHaveBeenCalledWith("browser-cli", ["wait", "1000"], controller.signal);
	});
});
