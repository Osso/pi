import { expect, it, vi } from "vitest";
import debugExtension from "../extensions/debug/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";

it("enables and disables the process debug REPL through /debug", async () => {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	const enable = vi.fn().mockResolvedValue("/tmp/pi-debug.sock");
	const disable = vi.fn().mockResolvedValue(undefined);
	const pi = {
		registerCommand: (_name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			command = value;
		},
	} as unknown as ExtensionAPI;
	debugExtension(pi, { enable, disable });
	if (!command) throw new Error("/debug command was not registered");

	const notify = vi.fn();
	const ctx = {
		sessionManager: { getSessionId: () => "session-123" },
		ui: { notify },
	} as unknown as ExtensionCommandContext;

	await command.handler("", ctx);
	expect(enable).toHaveBeenCalledWith("session-123");
	expect(notify).toHaveBeenCalledWith("Debug REPL enabled: pi debug attach session-123", "warning");

	await command.handler("off", ctx);
	expect(disable).toHaveBeenCalledOnce();
	expect(notify).toHaveBeenCalledWith("Debug REPL disabled", "info");
});
