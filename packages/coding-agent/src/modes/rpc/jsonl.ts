import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * LF-only line splitting for JSONL streams.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 *
 * Each chunk is scanned once and a long line is joined from its parts when it ends,
 * so reading a line costs time linear in its length however many chunks carry it.
 */
export function createJsonlLineSplitter(onLine: (line: string) => void) {
	const decoder = new StringDecoder("utf8");
	let parts: string[] = [];
	let pendingBytes = 0;

	const emitLine = (lastPart: string) => {
		parts.push(lastPart);
		const line = parts.join("");
		parts = [];
		pendingBytes = 0;
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onText = (text: string) => {
		let start = 0;
		for (let newlineIndex = text.indexOf("\n"); newlineIndex !== -1; newlineIndex = text.indexOf("\n", start)) {
			emitLine(text.slice(start, newlineIndex));
			start = newlineIndex + 1;
		}
		if (start === text.length) return;
		const tail = text.slice(start);
		parts.push(tail);
		pendingBytes += Buffer.byteLength(tail);
	};

	return {
		write: (chunk: string | Buffer) => onText(typeof chunk === "string" ? chunk : decoder.write(chunk)),
		/** UTF-8 size of the line read so far that no LF has ended yet. */
		pendingBytes: () => pendingBytes,
		end: () => {
			onText(decoder.end());
			if (parts.length > 0) emitLine("");
		},
	};
}

/** Attach an LF-only JSONL reader to a stream (see {@link createJsonlLineSplitter}). */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const splitter = createJsonlLineSplitter(onLine);
	const onData = (chunk: string | Buffer) => splitter.write(chunk);
	const onEnd = () => splitter.end();

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

/** The LF-only lines of a stream, in order; stopping early destroys the stream. */
export async function* readJsonlLines(stream: Readable): AsyncGenerator<string> {
	const lines: string[] = [];
	const splitter = createJsonlLineSplitter((line) => lines.push(line));
	for await (const chunk of stream) {
		splitter.write(chunk);
		yield* lines.splice(0);
	}
	splitter.end();
	yield* lines.splice(0);
}
