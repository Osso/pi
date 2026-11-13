import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ExternalEditorContext {
	openExternalEditor(): Promise<void>;
}

describe("InteractiveMode external editor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects with a clear error when the editor program cannot be started", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const ui = { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() };
		const setText = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype) as ExternalEditorContext, {
			runtimeHost: {
				session: { settingsManager: { getExternalEditorCommand: () => "/nonexistent/pi-test-editor --wait" } },
			},
			editor: { getText: () => "draft", setText },
			ui,
		});

		await expect(context.openExternalEditor()).rejects.toThrow(
			"External editor failed: could not start /nonexistent/pi-test-editor",
		);
		expect(setText).not.toHaveBeenCalled();
		expect(ui.start).toHaveBeenCalledOnce();
	});
});
