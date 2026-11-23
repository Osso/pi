import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createClipboardTempFileTracker } from "../../../src/utils/clipboard-temp-files.ts";
import { createHarness } from "../harness.ts";

type StreamingSubmitContext = Record<string, unknown>;
const submitStreamingPrompt = (
	InteractiveMode.prototype as unknown as {
		submitStreamingPrompt(this: StreamingSubmitContext, text: string, behavior: "steer" | "followUp"): Promise<void>;
	}
).submitStreamingPrompt;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["steer", "followUp"] as const)(
	"deletes a pasted clipboard image queued as %s after the answer, not before",
	async (behavior) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-queued-clipboard-"));
		tempDirs.push(dir);
		const pastedFile = join(dir, "pi-clipboard-image.png");
		writeFileSync(pastedFile, "png");
		const tracker = createClipboardTempFileTracker();
		tracker.track(pastedFile);
		const harness = await createHarness();
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let announceStart = () => {};
		const started = new Promise<void>((resolve) => {
			announceStart = resolve;
		});
		let existedWhenModelSawPrompt: boolean | undefined;
		harness.setResponses([
			async () => {
				announceStart();
				await released;
				return fauxAssistantMessage("Working");
			},
			() => {
				existedWhenModelSawPrompt = existsSync(pastedFile);
				return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Described" }), { stopReason: "toolUse" });
			},
		]);
		const showError = vi.fn();
		const context: StreamingSubmitContext = {
			session: harness.session,
			clipboardTempFiles: tracker,
			editor: { setText: vi.fn() },
			addSubmittedTextToHistory: vi.fn(),
			showError,
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const initial = harness.session.prompt("Start a long response");
		try {
			await started;
			await submitStreamingPrompt.call(context, `describe ${pastedFile}`, behavior);
			expect(existsSync(pastedFile)).toBe(true);
			release();
			await initial;
			await expect.poll(() => existedWhenModelSawPrompt).toBe(true);
			await expect.poll(() => existsSync(pastedFile)).toBe(false);
			expect(showError).not.toHaveBeenCalled();
		} finally {
			release();
			await initial;
			harness.cleanup();
		}
	},
);
