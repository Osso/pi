import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

let tempRoot: string | undefined;

afterEach(() => {
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

it("returns filenames with leading or trailing spaces unchanged", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-find-spaces-"));
	tempRoot = root;
	for (const name of ["report.txt ", " notes.txt", "plain.txt"]) writeFileSync(join(root, name), "");
	const def = createFindToolDefinition(root);
	const ctx = {} as Parameters<typeof def.execute>[4];

	const result = await def.execute("call-1", { pattern: "*.txt*" }, undefined, undefined, ctx);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	const files = text.split("\n").sort();

	expect(files).toEqual([" notes.txt", "plain.txt", "report.txt "]);
	for (const file of files) expect(existsSync(join(root, file))).toBe(true);
});
