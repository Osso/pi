import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";

describe.skipIf(process.platform === "win32")("processFileArguments with pipes", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-file-args-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("includes the content of a named pipe such as @<(git diff)", async () => {
		const pipePath = join(testDir, "diff.pipe");
		execFileSync("mkfifo", [pipePath]);
		const writer = writeFile(pipePath, "diff --git a/x b/x\n+hello from pipe\n");

		const result = await processFileArguments([pipePath]);
		await writer;

		expect(result.text).toBe(`<file name="${pipePath}">\ndiff --git a/x b/x\n+hello from pipe\n\n</file>\n`);
		expect(result.images).toEqual([]);
	});
});
