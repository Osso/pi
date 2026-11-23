import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEditTool } from "../../../src/core/tools/edit.ts";

it("edits one line of a 5.6 MB file without re-reading the growing output for every line", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-edit-large-file-"));
	const line = `${"0123456789".repeat(5)}\n`;
	const unchanged = line.repeat(55_000);
	const path = join(cwd, "large.txt");
	try {
		writeFileSync(path, `${unchanged}old\n${unchanged}`);
		const started = performance.now();
		await createEditTool(cwd).execute("edit-large-file", {
			path: "large.txt",
			edits: [{ oldText: "old\n", newText: "new\n" }],
		});
		const elapsedMs = performance.now() - started;

		expect(readFileSync(path, "utf8")).toBe(`${unchanged}new\n${unchanged}`);
		// The per-line join was quadratic: over 80 s for this file. A linear join takes well under a second.
		expect(elapsedMs).toBeLessThan(10_000);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}, 120_000);
