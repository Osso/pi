import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode update checks", () => {
	it("does not run startup version or package update checks", async () => {
		const checkForPackageUpdates = vi.fn(async () => ["extension"]);
		const showNewVersionNotification = vi.fn();
		const showPackageUpdateNotification = vi.fn();
		const sentinel = new Error("stop after startup");
		const context = {
			checkForPackageUpdates,
			checkTmuxKeyboardSetup: async () => undefined,
			continueInterruptedResumedSession: async () => undefined,
			getUserInput: async () => {
				throw sentinel;
			},
			init: async () => undefined,
			maybeWarnAboutAnthropicSubscriptionAuth: async () => undefined,
			processControlMessage: async () => undefined,
			options: {},
			session: {
				modelRegistry: {
					getError: () => undefined,
				},
			},
			showError: vi.fn(),
			showNewVersionNotification,
			showPackageUpdateNotification,
			showWarning: vi.fn(),
			version: "0.79.9",
		};

		await expect(InteractiveMode.prototype.run.call(context as never)).rejects.toThrow(sentinel);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(checkForPackageUpdates).not.toHaveBeenCalled();
		expect(showNewVersionNotification).not.toHaveBeenCalled();
		expect(showPackageUpdateNotification).not.toHaveBeenCalled();
	});
});
