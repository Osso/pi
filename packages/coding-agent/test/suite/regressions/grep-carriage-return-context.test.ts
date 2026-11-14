import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition } from "../../../src/core/tools/grep.ts";

describe.each([
	{
		name: "bare carriage returns",
		content: "progress\rreplacement\nneedle\nlast\n",
		before: "progressreplacement",
	},
	{
		name: "CRLF line endings",
		content: "before\r\nneedle\r\nlast\r\n",
		before: "before",
	},
])("grep context with $name", ({ content, before }) => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-grep-context-"));
		writeFileSync(join(tempRoot, "progress.log"), content);
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it.each([0, 1])("keeps ripgrep line numbers with context=%i", async (context) => {
		const definition = createGrepToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof definition.execute>[4];
		const result = await definition.execute(
			"grep-context",
			{ pattern: "needle", context },
			undefined,
			undefined,
			ctx,
		);
		const expected = context
			? [`progress.log-1- ${before}`, "progress.log:2: needle", "progress.log-3- last"]
			: ["progress.log:2: needle"];
		expect(result.content).toEqual([{ type: "text", text: expected.join("\n") }]);
	});
});
