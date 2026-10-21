import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const readerUrl = new URL("../src/core/session-transcript.ts", import.meta.url).href;

// A fresh process has no Vitest error handlers that could mask an unhandled stream error.
const consumeScript = `
import { createSessionTranscriptReadStream } from ${JSON.stringify(readerUrl)};
try {
 let text = "";
 for await (const chunk of createSessionTranscriptReadStream(process.argv[1])) text += chunk;
 console.log(JSON.stringify({ text }));
} catch (error) {
 console.log(JSON.stringify({ error: error.code }));
}
`;

describe("public session transcript stream", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-stream-test-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("makes truncated zstd errors catchable without killing the consumer process", () => {
		const path = join(root, "truncated.jsonl.zst");
		const compressed = zstdCompressSync("header\nUnicode café 🧭\n".repeat(100_000));
		writeFileSync(path, compressed.subarray(0, compressed.length - 1));
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", consumeScript, path], {
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ error: "Z_BUF_ERROR" });
		expect(child.stderr).not.toContain("Unhandled 'error' event");
	});

	it.each(["plain", "zstd", "corrupt", "missing"])("preserves ordinary stream outcomes: %s", (kind) => {
		const path = join(root, kind === "plain" ? "session.jsonl" : "session.jsonl.zst");
		const text = "header\nUnicode café 🧭\n";
		if (kind !== "missing")
			writeFileSync(path, kind === "zstd" ? zstdCompressSync(text) : kind === "corrupt" ? "not zstd" : text);
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", consumeScript, path], {
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		if (kind === "plain" || kind === "zstd") expect(JSON.parse(child.stdout)).toEqual({ text });
		else expect(JSON.parse(child.stdout)).toHaveProperty("error");
	});
});
