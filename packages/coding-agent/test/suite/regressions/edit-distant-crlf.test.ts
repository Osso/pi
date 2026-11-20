import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/edit.ts";

it.each([
	["exact", "A\nX\nX\r\nB\n", "A"],
	["fuzzy", "A \nX\nX\r\nB\n", "A\t"],
])(
	"preserves untouched mixed endings between separate %s edits that create a repeated line",
	async (_mode, original, oldText) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-edit-distant-crlf-"));
		const expected = "X\nX\nX\r\nZ\n";
		const filename = "mixed.txt";
		const path = join(cwd, filename);
		try {
			writeFileSync(path, original);
			const result = await createEditTool(cwd).execute("edit-distant-crlf", {
				path: filename,
				edits: [
					{ oldText, newText: "X" },
					{ oldText: "B", newText: "Z" },
				],
			});
			expect(readFileSync(path)).toEqual(Buffer.from(expected));
			expect(applyPatch(original, result.details?.patch ?? "")).toBe(expected);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
