import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLsTool } from "../../../src/core/tools/ls.ts";

describe("ls delegated to rtk", () => {
	let tempDir: string;
	const originalPath = process.env.PATH;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-ls-rtk-"));
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir);
		const rtk = join(binDir, "rtk");
		writeFileSync(rtk, '#!/bin/sh\nshift\nexec ls -1 "$1"\n');
		chmodSync(rtk, 0o755);
		process.env.PATH = `${binDir}:${originalPath}`;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("applies the entry limit when the listing exceeds the capture buffer", async () => {
		const listed = join(tempDir, "listed");
		mkdirSync(listed);
		for (let index = 0; index < 120; index++) {
			writeFileSync(join(listed, `${String(index).padStart(3, "0")}-${"x".repeat(200)}`), "");
		}

		const result = await createLsTool(tempDir).execute("ls-rtk-large", { path: listed, limit: 1 });
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

		expect(text).toBe(`000-${"x".repeat(200)}\n\n[1 entries limit reached. Use limit=2 for more]`);
	});
});
