import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFindTool } from "../../../src/core/tools/find.ts";
import { createReadTool } from "../../../src/core/tools/read.ts";

it.skipIf(process.platform === "win32")(
	"returns a POSIX filename ending in a backslash as a readable path",
	async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-find-backslash-"));
		const filename = "notes\\today\\";
		const contents = "The trailing backslash belongs to the file name.";
		try {
			writeFileSync(join(cwd, filename), contents);
			const found = await createFindTool(cwd).execute("find-backslash", { pattern: "notes*" });
			const match = found.content[0];
			if (match?.type !== "text") throw new Error("Find did not return a text path");
			expect(match.text).toBe(filename);

			const read = await createReadTool(cwd).execute("read-backslash", { path: match.text });
			expect(read.content).toEqual([{ type: "text", text: contents }]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
