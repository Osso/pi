import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { archiveIdleSessionTranscripts } from "../../../src/core/idle-session-archive.ts";

const [root, file, db, scenario, worker, now] = process.argv.slice(2);
const gates = join(root, "gates");
const exists = fs.existsSync;
const write = fs.writeFileSync;
const sleep = new Int32Array(new SharedArrayBuffer(4));
const boundaries: { operation: string; code?: string; syscall?: string; message: string }[] = [];

// File IPC can pause synchronous fs calls without letting another JS task run inside them.
function barrier(phase: string): void {
	write(join(gates, `${worker}-${phase}.ready`), "");
	const deadline = Date.now() + 12_000;
	while (!exists(join(gates, `${worker}-${phase}.release`))) {
		if (Date.now() >= deadline) throw new Error(`Archive race barrier timed out: ${worker}/${phase}`);
		Atomics.wait(sleep, 0, 0, 5);
	}
}

async function waitForCompressionRelease(deadline: number): Promise<void> {
	while (!exists(join(gates, `${worker}-compressing.release`))) {
		if (Date.now() >= deadline) throw new Error("Compression barrier timed out");
		await delay(5);
	}
}

function recordFailure(operation: string, error: unknown): never {
	boundaries.push({
		operation,
		code: error instanceof Error && "code" in error ? String(error.code) : undefined,
		syscall: error instanceof Error && "syscall" in error ? String(error.syscall) : undefined,
		message: error instanceof Error ? error.message : String(error),
	});
	throw error;
}

fs.existsSync = new Proxy(fs.existsSync, {
	apply(target, receiver, args) {
		const present = Reflect.apply(target, receiver, args);
		if (scenario === "publish" && String(args[0]) === `${file}.zst` && !present) barrier("target-absent");
		return present;
	},
});
let procScans = 0;
fs.readdirSync = new Proxy(fs.readdirSync, {
	apply(target, receiver, args) {
		// Both byte comparisons must close their source descriptors before either ownership recheck.
		if (scenario === "publish" && String(args[0]) === "/proc" && ++procScans === 2) barrier("verified");
		return Reflect.apply(target, receiver, args);
	},
});
fs.createWriteStream = new Proxy(fs.createWriteStream, {
	apply(target, receiver, args) {
		const stream: fs.WriteStream = Reflect.apply(target, receiver, args);
		if (scenario !== "compromised") return stream;
		const originalWrite = stream._write;
		stream._write = (chunk, encoding, callback) => {
			stream._write = originalWrite;
			originalWrite.call(stream, chunk, encoding, (error) => {
				write(join(gates, `${worker}-compressing.ready`), "");
				const deadline = Date.now() + 12_000;
				void waitForCompressionRelease(deadline).then(callback.bind(undefined, error), callback);
			});
		};
		return stream;
	},
});
let sourceStats = 0;
Object.defineProperty(fs, "lstatSync", {
	value: new Proxy(fs.lstatSync, {
		apply(target, receiver, args) {
			if (String(args[0]) !== file) return Reflect.apply(target, receiver, args);
			// Candidate enumeration and realpath have succeeded; hold this pass before its first stat.
			if (scenario === "stale" && worker === "winner" && ++sourceStats === 1) barrier("candidate");
			if (scenario === "external-delete") fs.unlinkSync(file);
			try {
				return Reflect.apply(target, receiver, args);
			} catch (error) {
				return recordFailure("lstat", error);
			}
		},
	}),
});
fs.linkSync = new Proxy(fs.linkSync, {
	apply(target, receiver, args) {
		if (String(args[1]) === `${file}.zst`) barrier("publish");
		try {
			return Reflect.apply(target, receiver, args);
		} catch (error) {
			return recordFailure("link", error);
		}
	},
});
syncBuiltinESMExports();
try {
	const result = await archiveIdleSessionTranscripts(db, { agentDir: root, now: Number(now) });
	write(join(gates, `${worker}-done.json`), JSON.stringify({ result, boundaries }));
} catch (error) {
	write(
		join(gates, `${worker}-done.json`),
		JSON.stringify({
			result: { archivedPaths: [], errors: [] },
			boundaries,
			failure: {
				code: error instanceof Error && "code" in error ? String(error.code) : undefined,
				message: error instanceof Error ? error.message : String(error),
			},
		}),
	);
}
