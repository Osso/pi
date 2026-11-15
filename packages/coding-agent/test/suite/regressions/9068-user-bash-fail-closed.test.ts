import { describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, UserBashEventResult } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "../harness.ts";

// Regression for https://github.com/earendil-works/pi-mono/issues/9068: a failing user_bash
// routing handler (for example a sandbox) must not fall back to running the command locally.

const handleBashCommand = (
	InteractiveMode.prototype as unknown as {
		handleBashCommand(this: unknown, command: string, excludeFromContext?: boolean): Promise<void>;
	}
).handleBashCommand;

const failingHandlers: Array<[string, (pi: ExtensionAPI) => void]> = [
	[
		"throws",
		(pi) => {
			pi.on("user_bash", async () => {
				throw new Error("Routing failed");
			});
		},
	],
	[
		"returns an empty result",
		(pi) => {
			pi.on("user_bash", async () => ({}) as unknown as UserBashEventResult);
		},
	],
];

describe("interactive user_bash failure handling (#9068)", () => {
	test.each(failingHandlers)("does not execute bash locally when the handler %s", async (_name, extension) => {
		const harness = await createHarness({ extensionFactories: [extension] });
		const executeBash = vi
			.spyOn(harness.session, "executeBash")
			.mockResolvedValue({ output: "local output", exitCode: 0, cancelled: false, truncated: false });
		const context = {
			session: harness.session,
			sessionManager: harness.sessionManager,
			ui: { requestRender: vi.fn() },
			chatContainer: { addChild: vi.fn() },
			pendingMessagesContainer: { addChild: vi.fn() },
			pendingBashComponents: [],
			setPromptActivity: vi.fn(),
			showError: vi.fn(),
			invalidateFooterAfterBashResult: vi.fn(),
		};
		try {
			await handleBashCommand.call(context, "pwd");
			expect(executeBash).not.toHaveBeenCalled();
			expect(context.chatContainer.addChild).not.toHaveBeenCalled();
		} finally {
			executeBash.mockRestore();
			harness.cleanup();
		}
	});
});
