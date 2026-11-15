import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
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

describe("@file CLI arguments", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-file-args-"));
		vi.spyOn(process, "cwd").mockReturnValue(testDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("strips only the CLI @ prefix from a file whose name starts with @", async () => {
		writeFileSync(join(testDir, "@notes.md"), "scoped notes");

		const result = await processFileArguments(parseArgs(["@@notes.md"]).fileArgs);

		expect(result.text).toBe(`<file name="${join(testDir, "@notes.md")}">\nscoped notes\n</file>\n`);
	});

	it("reads a plain @file argument relative to the working directory", async () => {
		writeFileSync(join(testDir, "README.md"), "readme");

		const result = await processFileArguments(parseArgs(["@README.md"]).fileArgs);

		expect(result.text).toBe(`<file name="${join(testDir, "README.md")}">\nreadme\n</file>\n`);
	});
});
