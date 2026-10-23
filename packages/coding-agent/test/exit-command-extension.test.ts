import { expect, it, vi } from "vitest";
import exitCommandExtension from "../extensions/exit-command/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";

it("registers /exit and requests graceful session shutdown", async () => {
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi = {
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			commands.set(name, command);
		},
	} as ExtensionAPI;
	const shutdown = vi.fn();
	exitCommandExtension(pi);

	expect([...commands.keys()]).toEqual(["exit"]);
	expect(shutdown).not.toHaveBeenCalled();
	await commands.get("exit")!.handler("", { shutdown } as ExtensionCommandContext);
	expect(shutdown).toHaveBeenCalledOnce();
});
