import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGrepTool } from "../../../src/core/tools/grep.ts";

it.skipIf(process.platform === "win32")("keeps a backslash in a POSIX filename for grep paths and globs", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-grep-backslash-"));
	try {
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "a\\b.ts"), "needle\n");
		writeFileSync(join(cwd, "src", "control.ts"), "needle\n");
		const grep = createGrepTool(cwd);
		const textOf = (result: Awaited<ReturnType<typeof grep.execute>>) =>
			result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

		const plain = textOf(await grep.execute("grep-backslash", { pattern: "needle" }));
		expect(plain.split("\n").sort()).toEqual(["src/a\\b.ts:1: needle", "src/control.ts:1: needle"]);

		const globbed = textOf(await grep.execute("grep-backslash-glob", { pattern: "needle", glob: "src/*.ts" }));
		expect(globbed.split("\n").sort()).toEqual(["src/a\\b.ts:1: needle", "src/control.ts:1: needle"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
