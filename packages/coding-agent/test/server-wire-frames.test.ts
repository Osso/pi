import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, readFrames } from "../src/cli/server-wire.ts";

function readAll(stream: Readable): Promise<{ frames: Record<string, unknown>[]; invalid: string[] }> {
	const frames: Record<string, unknown>[] = [];
	const invalid: string[] = [];
	readFrames(
		stream,
		(frame) => frames.push(frame),
		(line) => invalid.push(line),
	);
	return new Promise((resolve) => stream.on("close", () => resolve({ frames, invalid })));
}

describe("pi server frame reader", () => {
	// Hub links and the stdio connector carry each attach snapshot as one frame; rescanning it per chunk took ~5 s at 40 MB.
	it("reads a 40 MB frame with U+2028 delivered in 64 KiB chunks within seconds", async () => {
		const snapshot = { type: "response", id: "a", data: { text: "x\u2028".repeat(10_000_000) } };
		const bytes = Buffer.from(`${JSON.stringify(snapshot)}\r\nnot json\n${JSON.stringify({ type: "next" })}\n`);
		const chunks: Buffer[] = [];
		for (let offset = 0; offset < bytes.length; offset += 65_536)
			chunks.push(bytes.subarray(offset, offset + 65_536));
		const started = performance.now();

		const { frames, invalid } = await readAll(Readable.from(chunks));

		expect(performance.now() - started).toBeLessThan(5_000);
		expect(frames).toEqual([snapshot, { type: "next" }]);
		expect(invalid).toEqual(["not json"]);
	});

	it("destroys the stream once an unterminated frame passes the size limit", async () => {
		const stream = new PassThrough();
		const read = readAll(stream);
		const errored = new Promise<Error>((resolve) => stream.on("error", resolve));
		stream.write(`${JSON.stringify({ type: "small" })}\n`);
		const chunk = "x".repeat(1_048_576);
		for (let written = 0; written <= MAX_FRAME_BYTES && !stream.destroyed; written += chunk.length)
			stream.write(chunk);

		expect((await errored).message).toBe("Frame exceeds 64 MiB");
		expect((await read).frames).toEqual([{ type: "small" }]);
	});
});
