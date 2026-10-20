import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { readSessionTranscriptPath } from "./session-transcript.ts";

// The manager API is synchronous, but Node's bounded-memory zstd decoder is a
// stream. Run that stream off-thread and spool to disk for the reverse scanner.
// A data URL needs no worker asset in source, npm, or compiled executable layouts.
const spoolWorker = new URL(
	`data:text/javascript,${encodeURIComponent(`
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { workerData } from "node:worker_threads";
import { createZstdDecompress } from "node:zlib";
const status = new Int32Array(workerData.status);
try {
	await pipeline(
		createReadStream(workerData.source),
		createZstdDecompress(),
		createWriteStream(workerData.target, { flags: "wx", mode: 0o600 }),
	);
	Atomics.store(status, 0, 1);
} catch (error) {
	workerData.port.postMessage(String(error));
	Atomics.store(status, 0, 2);
} finally {
	workerData.port.close();
	Atomics.notify(status, 0);
}
`)}`,
);
const SPOOL_TIMEOUT_MS = 90_000;

function spoolArchivedTranscript(source: string, target: string): void {
	const status = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	const { port1, port2 } = new MessageChannel();
	let worker: Worker | undefined;
	try {
		worker = new Worker(spoolWorker, {
			workerData: { source, target, status: status.buffer, port: port2 },
			transferList: [port2],
			execArgv: [],
		});
		worker.once("error", (error) => console.error(`Transcript decompression worker failed for ${source}:`, error));
		const wait = Atomics.wait(status, 0, 0, SPOOL_TIMEOUT_MS);
		if (wait === "timed-out") throw new Error(`Timed out decompressing session transcript: ${source}`);
		if (Atomics.load(status, 0) !== 1) {
			const error = receiveMessageOnPort(port1)?.message;
			throw new Error(`Cannot decompress session transcript ${source}: ${error}`);
		}
	} finally {
		port1.close();
		port2.close();
		void worker?.terminate();
	}
}

/** Supply a seekable plain transcript without restoring or changing an archive. */
export function withSeekableSessionTranscript<T>(path: string, read: (plain: string) => T): T {
	const source = readSessionTranscriptPath(path);
	if (!source.endsWith(".jsonl.zst")) return read(source);
	const directory = mkdtempSync(join(tmpdir(), "pi-transcript-"));
	try {
		const plain = join(directory, "transcript.jsonl");
		spoolArchivedTranscript(source, plain);
		return read(plain);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
