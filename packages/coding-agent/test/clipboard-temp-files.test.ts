import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createClipboardTempFileTracker } from "../src/utils/clipboard-temp-files.ts";
import { createHarness } from "./suite/harness.ts";

const idleSession = { isStreaming: false, subscribe: () => () => {} };

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-clipboard-temp-test-"));
	tempDirs.push(dir);
	return dir;
}

function createFile(dir: string, name: string): string {
	const filePath = join(dir, name);
	writeFileSync(filePath, "data");
	return filePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("createClipboardTempFileTracker", () => {
	test("deletes tracked clipboard temp files after their submitted text is answered", () => {
		const dir = createTempDir();
		const pastedFile = createFile(dir, "pi-clipboard-image.png");
		const unrelatedFile = createFile(dir, "unrelated.png");
		const tracker = createClipboardTempFileTracker();

		tracker.track(pastedFile);
		tracker.cleanupReferencedIn(`describe ${pastedFile}`, idleSession);

		expect(existsSync(pastedFile)).toBe(false);
		expect(existsSync(unrelatedFile)).toBe(true);
	});

	test("keeps tracked clipboard temp files until submitted text references them", () => {
		const dir = createTempDir();
		const pastedFile = createFile(dir, "pi-clipboard-image.png");
		const tracker = createClipboardTempFileTracker();

		tracker.track(pastedFile);
		tracker.cleanupReferencedIn("different prompt", idleSession);

		expect(existsSync(pastedFile)).toBe(true);
	});

	test("keeps a file referenced by text queued into a running turn until that run ends", async () => {
		const pastedFile = createFile(createTempDir(), "pi-clipboard-image.png");
		const tracker = createClipboardTempFileTracker();
		tracker.track(pastedFile);
		const harness = await createHarness();
		let announceStart = () => {};
		const started = new Promise<void>((resolve) => {
			announceStart = resolve;
		});
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let existedWhenModelSawSteer: boolean | undefined;
		harness.setResponses([
			async () => {
				announceStart();
				await released;
				return fauxAssistantMessage("Working");
			},
			() => {
				existedWhenModelSawSteer = existsSync(pastedFile);
				return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Described" }), { stopReason: "toolUse" });
			},
		]);
		const initial = harness.session.prompt("Start a long response");
		try {
			await started;
			const steer = `describe ${pastedFile}`;
			await harness.session.prompt(steer, { streamingBehavior: "steer" });
			tracker.cleanupReferencedIn(steer, harness.session);
			expect(existsSync(pastedFile)).toBe(true);

			release();
			await initial;
			expect(existedWhenModelSawSteer).toBe(true);
			await expect.poll(() => existsSync(pastedFile)).toBe(false);
		} finally {
			release();
			await initial;
			harness.cleanup();
		}
	});
});
