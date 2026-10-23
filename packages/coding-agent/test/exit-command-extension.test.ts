import { expect, it, vi } from "vitest";
import exitCommandExtension from "../extensions/exit-command/src/index.ts";
import { createHarnessWithExtensions } from "./test-harness.ts";

it("registers /exit and requests graceful session shutdown", async () => {
	const harness = await createHarnessWithExtensions({ extensionFactories: [exitCommandExtension] });
	try {
		const runner = harness.session.extensionRunner;
		if (!runner) throw new Error("Expected the extension runner");
		const command = runner.getCommand("exit");
		if (!command) throw new Error("Expected the bundled exit command");
		const context = runner.createCommandContext();
		const shutdown = vi.fn();
		context.shutdown = shutdown;

		expect(shutdown).not.toHaveBeenCalled();
		await command.handler("", context);
		expect(shutdown).toHaveBeenCalledOnce();
	} finally {
		harness.cleanup();
	}
});
