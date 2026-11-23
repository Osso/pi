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

	async function grepFiles(glob?: string): Promise<string[]> {
		const def = createGrepToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern: "needle", glob }, undefined, undefined, ctx)) as {
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

	it.each([
		{ insideGit: false, glob: "*.ts", expected: ["kept.ts", "src/deep/nested.ts", "src/top.ts"] },
		{ insideGit: true, glob: "**/*.ts", expected: ["kept.ts", "src/deep/nested.ts", "src/top.ts"] },
		{ insideGit: false, glob: "src/*.ts", expected: ["src/top.ts"] },
		{ insideGit: true, glob: "src/**/*.ts", expected: ["src/deep/nested.ts", "src/top.ts"] },
		{ insideGit: false, glob: "{src/*.ts,kept.ts}", expected: ["kept.ts", "src/top.ts"] },
		{ insideGit: true, glob: "{src/deep/*.ts,*.txt}", expected: ["kept.txt", "src/deep/nested.ts"] },
		{ insideGit: false, glob: "./*.ts", expected: ["kept.ts"] },
		{ insideGit: false, glob: "src/{deep/*.ts,top.ts}", expected: ["src/deep/nested.ts", "src/top.ts"] },
	])(
		"filters by $glob without including ignored files (insideGit: $insideGit)",
		async ({ insideGit, glob, expected }) => {
			if (insideGit) mkdirSync(join(tempRoot, ".git"));
			writeFileSync(join(tempRoot, ".gitignore"), "ignored.txt\nignored.ts\nbuild/\n");
			writeFileSync(join(tempRoot, "ignored.ts"), "needle\n");
			writeFileSync(join(tempRoot, "kept.ts"), "needle\n");
			writeFileSync(join(tempRoot, "build", "out.ts"), "needle\n");
			mkdirSync(join(tempRoot, "src", "deep"), { recursive: true });
			writeFileSync(join(tempRoot, "src", "top.ts"), "needle\n");
			writeFileSync(join(tempRoot, "src", "ignored.ts"), "needle\n");
			writeFileSync(join(tempRoot, "src", "deep", "nested.ts"), "needle\n");
			expect(await grepFiles(glob)).toEqual(expected);
		},
	);

	it("supports exclusion globs without including ignored files", async () => {
		writeFileSync(join(tempRoot, "other.ts"), "needle\n");
		expect(await grepFiles("!*.ts")).toEqual(["kept.txt"]);
	});

	it.each(["#notes/*.ts", "./#notes/*.ts"])("matches a directory whose name starts with # (%s)", async (glob) => {
		mkdirSync(join(tempRoot, "#notes"));
		writeFileSync(join(tempRoot, "#notes", "kept.ts"), "needle\n");
		expect(await grepFiles(glob)).toEqual(["#notes/kept.ts"]);
	});

	it("excludes only top-level files with a ./ exclusion glob", async () => {
		mkdirSync(join(tempRoot, "src"));
		writeFileSync(join(tempRoot, "src", "nested.txt"), "needle\n");
		expect(await grepFiles("!./*.txt")).toEqual(["src/nested.txt"]);
	});
});
