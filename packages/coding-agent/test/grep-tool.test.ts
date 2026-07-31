import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

const originalPath = process.env.PATH;
const originalArgsPath = process.env.RG_ARGS_PATH;
let testDir: string | undefined;

afterEach(() => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalArgsPath === undefined) delete process.env.RG_ARGS_PATH;
	else process.env.RG_ARGS_PATH = originalArgsPath;
	if (testDir) rmSync(testDir, { recursive: true, force: true });
	testDir = undefined;
});

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("grep tool", () => {
	it("bounds ripgrep JSON lines before parsing them", async () => {
		testDir = mkdtempSync(join(tmpdir(), "pi-grep-max-columns-"));
		const argsPath = join(testDir, "args.json");
		const rgPath = join(testDir, "rg");
		const searchedFile = join(testDir, "searched.txt");
		writeFileSync(searchedFile, "match\n");
		writeFileSync(
			rgPath,
			`#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") {
  process.stdout.write("ripgrep 15.2.0\\n");
  process.exit(0);
}
fs.writeFileSync(process.env.RG_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const searchedFile = process.argv.at(-1);
process.stdout.write(JSON.stringify({
  type: "match",
  data: {
    path: { text: searchedFile },
    lines: { text: "match\\n" },
    line_number: 1,
  },
}) + "\\n");
`,
		);
		chmodSync(rgPath, 0o755);
		process.env.PATH = `${testDir}${delimiter}${originalPath ?? ""}`;
		process.env.RG_ARGS_PATH = argsPath;

		const result = await createGrepTool(testDir).execute("grep-max-columns", {
			pattern: "match",
			path: searchedFile,
		});

		const ripgrepArgs = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
		expect(getTextOutput(result)).toContain("searched.txt:1: match");
		expect(ripgrepArgs).toContain("--max-columns");
		expect(ripgrepArgs).toContain(String(DEFAULT_MAX_BYTES));
	});
});
