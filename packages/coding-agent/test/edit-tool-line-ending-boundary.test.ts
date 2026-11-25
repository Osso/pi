import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

describe("edit tool line-ending boundary preservation", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-edit-line-ending-boundary-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("preserves the LF after the matched range when changing its last line", async () => {
		const path = join(testDir, "mixed-range-boundary.txt");
		await writeFile(path, 'const text =\r\n  "value";\nnext();\n');

		await createEditTool(testDir).execute("edit-line-ending-boundary", {
			path: "mixed-range-boundary.txt",
			edits: [{ oldText: 'const text =\n  "value";', newText: 'const text = "value";' }],
		});

		expect(await readFile(path, "utf8")).toBe('const text = "value";\nnext();\n');
	});
});
