import { closeSync, mkdtempSync as fsMkdtempSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createReadTool } from "../../../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";

const PATH = "sparse.txt";
const FILE_SIZE = 2 * 1024 * 1024 * 1024;
const PREFIX = Buffer.from("alpha\nbeta\ngamma\n");

let cwd: string;

beforeEach(() => {
	cwd = fsMkdtempSync(join(tmpdir(), "pi-read-bounded-pagination-"));
	const descriptor = openSync(join(cwd, PATH), "w");
	try {
		writeSync(descriptor, PREFIX, 0, PREFIX.length, 0);
		ftruncateSync(descriptor, FILE_SIZE);
	} finally {
		closeSync(descriptor);
	}
});

afterEach(async () => {
	await fsRm(cwd, { recursive: true, force: true });
});

it("keeps the bounded initial page and full-file byte metadata", async () => {
	const result = await createReadTool(cwd).execute("read-default-page", { path: PATH });
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	expect(text).toContain("alpha\nbeta\ngamma");
	expect(text).toContain("offset=4");
	expect(result.details?.truncation).toMatchObject({
		truncated: true,
		truncatedBy: "bytes",
		totalBytes: FILE_SIZE,
		outputLines: 3,
	});
});

it("reads a small explicit page without a whole-file read", async () => {
	const result = await createReadTool(cwd).execute("read-small-page", {
		path: PATH,
		limit: 1,
	});

	expect(result.content).toEqual([
		{ type: "text", text: "alpha\n\n[3 more lines in file. Use offset=2 to continue.]" },
	]);
});

it("reads a later oversized page without a whole-file read", async () => {
	const result = await createReadTool(cwd).execute("read-later-page", {
		path: PATH,
		offset: 4,
	});
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	expect(text).toContain("Line 4 is");
	expect(text).toContain(`exceeds ${DEFAULT_MAX_BYTES / 1024}.0KB limit`);
	expect(result.details?.truncation).toMatchObject({
		truncated: true,
		truncatedBy: "bytes",
		firstLineExceedsLimit: true,
		totalBytes: FILE_SIZE - PREFIX.length,
		outputBytes: 0,
	});
});
