import { PassThrough, Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { attachJsonlLineReader, readJsonlLines, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

/** The bytes of `text` as a stream of 64 KiB chunks, the size a pipe delivers. */
function pipeChunks(text: string): Readable {
	const bytes = Buffer.from(text);
	const chunks: Buffer[] = [];
	for (let offset = 0; offset < bytes.length; offset += 65_536) chunks.push(bytes.subarray(offset, offset + 65_536));
	return Readable.from(chunks);
}

describe("RPC JSONL framing", () => {
	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});

	// A whole attach snapshot (`get_messages`) is one line; rescanning the buffered line on every chunk took ~30 s at 50 MB.
	test("reads a 50 MB line delivered in 64 KiB chunks within seconds", async () => {
		const record = { text: "build step ok\u2028".repeat(3_500_000) };
		const stream = pipeChunks(`${serializeJsonLine(record)}${serializeJsonLine({ after: true })}`);
		const lines: string[] = [];
		const done = new Promise<void>((resolve) => stream.on("end", resolve));
		const started = performance.now();

		attachJsonlLineReader(stream, (line) => lines.push(line));
		await done;

		expect(performance.now() - started).toBeLessThan(5_000);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toEqual(record);
		expect(JSON.parse(lines[1])).toEqual({ after: true });
	});

	test("iterates LF-only lines and destroys the stream when iteration stops early", async () => {
		const stream = new PassThrough();
		stream.write('{"text":"a\u2028b"}\r\n{"second":');
		stream.write("true}\n");
		const lines: string[] = [];

		for await (const line of readJsonlLines(stream)) {
			lines.push(line);
			if (lines.length === 2) break;
		}

		expect(lines.map((line) => JSON.parse(line))).toEqual([{ text: "a\u2028b" }, { second: true }]);
		expect(stream.destroyed).toBe(true);
	});
});
