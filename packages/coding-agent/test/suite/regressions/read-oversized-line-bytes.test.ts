import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createReadTool } from "../../../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../../../src/core/tools/truncate.ts";

it("reports the file size when the head read cuts a multibyte character on the first line", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-read-oversized-line-"));
	const path = "long.txt";
	try {
		const bytes = Buffer.from(`${"a".repeat(DEFAULT_MAX_BYTES)}é\nnext\n`);
		writeFileSync(join(cwd, path), bytes);
		const result = await createReadTool(cwd).execute("read-oversized-line", { path });
		expect(result.details?.truncation).toMatchObject({
			firstLineExceedsLimit: true,
			totalBytes: bytes.length,
			outputBytes: 0,
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
