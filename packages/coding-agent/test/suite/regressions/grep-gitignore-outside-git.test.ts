import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../../../src/core/tools/grep.ts";

/**
 * The grep tool claims to respect .gitignore, but rg ignores .gitignore files
 * outside git repositories unless given --no-require-git. find already passed
 * that flag, so the two tools disagreed in non-git directories.
 */
describe("grep respects .gitignore outside git repositories", () => {
	let tempRoot: string;

	async function grepFiles(): Promise<string[]> {
		const def = createGrepToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern: "needle" }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		return [...new Set(text.split("\n").map((line) => line.split(":")[0] ?? ""))].filter(Boolean).sort();
	}

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-grep-gitignore-"));
		writeFileSync(join(tempRoot, ".gitignore"), "ignored.txt\nbuild/\n");
		writeFileSync(join(tempRoot, "ignored.txt"), "needle\n");
		writeFileSync(join(tempRoot, "kept.txt"), "needle\n");
		mkdirSync(join(tempRoot, "build"));
		writeFileSync(join(tempRoot, "build", "out.txt"), "needle\n");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("skips ignored files in a directory that is not a git repository", async () => {
		expect(await grepFiles()).toEqual(["kept.txt"]);
	});

	it("skips ignored files inside a git repository", async () => {
		mkdirSync(join(tempRoot, ".git"));
		expect(await grepFiles()).toEqual(["kept.txt"]);
	});
});
