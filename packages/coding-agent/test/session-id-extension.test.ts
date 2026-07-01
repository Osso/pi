import { describe, expect, it, vi } from "vitest";
import sessionIdExtension from "../extensions/session-id/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";

type SessionIdCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function createHarness() {
	let command: SessionIdCommand | undefined;
	const notify = vi.fn();

	const pi = {
		registerCommand(name: string, options: SessionIdCommand) {
			if (name === "session-id") {
				command = options;
			}
		},
	} as unknown as ExtensionAPI;

	sessionIdExtension(pi);

	const ctx = {
		ui: { notify },
		sessionManager: { getSessionId: () => "test-session-id" },
	} as unknown as ExtensionCommandContext;

	return {
		command,
		notify,
		runCommand: async () => {
			await command?.handler("", ctx);
		},
	};
}

describe("session id extension", () => {
	it("registers /session-id and displays the current session id", async () => {
		const harness = createHarness();

		expect(harness.command?.description).toBe("Show the current session id");

		await harness.runCommand();

		expect(harness.notify).toHaveBeenCalledWith("Session ID: test-session-id", "info");
	});
});
