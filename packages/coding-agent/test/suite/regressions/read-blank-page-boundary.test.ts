import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createReadTool } from "../../../src/core/tools/read.ts";

it.each([
	{ mode: "bounded head", prefix: "xxxx\n".repeat(2000), rest: `\n${"y".repeat(500)}\n`, limit: undefined },
	{ mode: "bounded head at EOF", prefix: `${"é".repeat(4120)}${"\n".repeat(2000)}`, rest: "\n", limit: undefined },
	{ mode: "explicit page", prefix: "x\n".repeat(2000), rest: "\nlast", limit: 2001 },
])("continues at the first undisplayed blank line ($mode)", async ({ prefix, rest, limit }) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-read-blank-page-"));
	const path = "lines.txt";
	try {
		writeFileSync(join(cwd, path), prefix + rest);
		const tool = createReadTool(cwd);
		const page = await tool.execute("read-first-page", { path, limit });
		const total = limit === undefined ? "file" : "2002";
		expect(page.content).toEqual([
			{
				type: "text",
				text: `${prefix.slice(0, -1)}\n\n[Showing lines 1-2000 of ${total}. Use offset=2001 to continue.]`,
			},
		]);
		expect(page.details?.truncation?.outputLines).toBe(2000);
		const nextPage = await tool.execute("read-next-page", { path, offset: 2001 });
		expect(nextPage.content).toEqual([{ type: "text", text: rest }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
