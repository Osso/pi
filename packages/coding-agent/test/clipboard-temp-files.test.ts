import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createClipboardTempFileTracker } from "../src/utils/clipboard-temp-files.ts";

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
		tracker.cleanupReferencedIn(`describe ${pastedFile}`);

		expect(existsSync(pastedFile)).toBe(false);
		expect(existsSync(unrelatedFile)).toBe(true);
	});

	test("keeps tracked clipboard temp files until submitted text references them", () => {
		const dir = createTempDir();
		const pastedFile = createFile(dir, "pi-clipboard-image.png");
		const tracker = createClipboardTempFileTracker();

		tracker.track(pastedFile);
		tracker.cleanupReferencedIn("different prompt");

		expect(existsSync(pastedFile)).toBe(true);
	});
});
