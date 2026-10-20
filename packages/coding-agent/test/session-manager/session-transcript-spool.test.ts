import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSeekableSessionTranscript } from "../../src/core/session-transcript-spool.ts";

describe("seekable archived transcript", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-spool-test-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("returns exact decoded bytes and deletes the temporary transcript after reading", () => {
		const archive = join(root, "session.jsonl.zst");
		const content = "header\nUnicode café 🧭\n";
		const compressed = zstdCompressSync(content);
		writeFileSync(archive, compressed);
		let temporary: string | undefined;
		const result = withSeekableSessionTranscript(archive, (plain) => {
			temporary = plain;
			return readFileSync(plain, "utf8");
		});
		expect(result).toBe(content);
		if (!temporary) throw new Error("Expected a temporary transcript path");
		expect(existsSync(temporary)).toBe(false);
		expect(readFileSync(archive)).toEqual(compressed);
		expect(existsSync(archive.slice(0, -4))).toBe(false);
	});

	it("cleans temporary storage when the transcript reader throws", () => {
		const archive = join(root, "session.jsonl.zst");
		writeFileSync(archive, zstdCompressSync("content"));
		let temporary: string | undefined;
		expect(() =>
			withSeekableSessionTranscript(archive, (plain) => {
				temporary = plain;
				throw new Error("reader failed");
			}),
		).toThrow("reader failed");
		if (!temporary) throw new Error("Expected a temporary transcript path");
		expect(existsSync(temporary)).toBe(false);
	});

	it("propagates corrupt archive errors rather than returning an empty session", () => {
		const archive = join(root, "corrupt.jsonl.zst");
		writeFileSync(archive, "not zstd");
		expect(() => withSeekableSessionTranscript(archive, () => "unreachable")).toThrow(
			/Cannot decompress session transcript.*corrupt.jsonl.zst/,
		);
		expect(readFileSync(archive, "utf8")).toBe("not zstd");
	});
});
