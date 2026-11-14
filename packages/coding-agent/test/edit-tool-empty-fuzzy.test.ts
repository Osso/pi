import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

describe("edit tool whitespace-only matching", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "pi-edit-empty-fuzzy-"));
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("rejects a missing tab instead of inserting text at the start of the file", async () => {
		const testFile = join(testDir, "sample.txt");
		await writeFile(testFile, "alpha\n");
		const editTool = createEditTool(testDir);

		await expect(
			editTool.execute("missing-tab", {
				path: "sample.txt",
				edits: [{ oldText: "\t", newText: "  " }],
			}),
		).rejects.toThrow(
			"Could not find the exact text in sample.txt. The old text must match exactly including all whitespace and newlines.",
		);
		expect(await readFile(testFile, "utf8")).toBe("alpha\n");
	});

	it("still replaces an exact whitespace-only match", async () => {
		const testFile = join(testDir, "sample.txt");
		await writeFile(testFile, "\talpha\n");
		const editTool = createEditTool(testDir);

		const result = await editTool.execute("exact-tab", {
			path: "sample.txt",
			edits: [{ oldText: "\t", newText: "  " }],
		});

		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in sample.txt." }]);
		expect(await readFile(testFile, "utf8")).toBe("  alpha\n");
	});
});
