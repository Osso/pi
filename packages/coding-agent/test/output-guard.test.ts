import { afterEach, describe, expect, it, vi } from "vitest";
import { flushRawStdout, writeRawStdout } from "../src/core/output-guard.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await flushRawStdout();
});

type WriteCallback = (error?: Error | null) => void;

function captureStdoutChunks(): string[] {
	const chunks: string[] = [];
	const writeMock = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	) => {
		chunks.push(String(chunk));
		const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		writeCallback?.();
		return true;
	};
	vi.spyOn(process.stdout, "write").mockImplementation(writeMock as typeof process.stdout.write);
	return chunks;
}

describe("writeRawStdout", () => {
	it("writes complete lines as separate chunks", async () => {
		const chunks = captureStdoutChunks();

		writeRawStdout("one\ntwo\nthree");
		await flushRawStdout();

		expect(chunks).toEqual(["one\n", "two\n", "three", ""]);
	});

	it("splits long lines into 1024-character chunks", async () => {
		const chunks = captureStdoutChunks();

		writeRawStdout(`${"a".repeat(2050)}\n`);
		await flushRawStdout();

		expect(chunks).toEqual(["a".repeat(1024), "a".repeat(1024), `${"a".repeat(2)}\n`, ""]);
	});
});
