import { hostname } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export const MAX_FRAME_BYTES = 1_048_576;

type FrameSink = Pick<Writable, "destroyed" | "writableLength" | "write" | "destroy">;

export function serverHostId(): string {
	return process.env.PI_SERVER_HOST_ID || hostname();
}

export function socketPath(): string {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (!runtimeDir) throw new Error("XDG_RUNTIME_DIR is required for pi server");
	return join(runtimeDir, "pi", "server.sock");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function writeFrame(sink: FrameSink, frame: unknown): void {
	if (sink.destroyed) return;
	const line = `${JSON.stringify(frame)}\n`;
	if (sink.writableLength + Buffer.byteLength(line) > MAX_FRAME_BYTES) {
		sink.destroy(new Error("Output buffer exceeds 1 MiB"));
		return;
	}
	sink.write(line);
}

/** Calls onFrame for every JSONL object on the stream; destroys the stream on a frame over 1 MiB. */
export function readFrames(
	stream: Readable,
	onFrame: (frame: Record<string, unknown>) => void,
	onInvalid: (line: string) => void,
): void {
	stream.setEncoding("utf8");
	let buffered = "";
	stream.on("data", (chunk: string) => {
		buffered += chunk;
		for (;;) {
			const newline = buffered.indexOf("\n");
			const pending = newline < 0 ? buffered : buffered.slice(0, newline);
			if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) {
				stream.destroy(new Error("Frame exceeds 1 MiB"));
				return;
			}
			if (newline < 0) return;
			const line = pending.replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			if (!line.trim()) continue;
			let frame: unknown;
			try {
				frame = JSON.parse(line);
			} catch {
				onInvalid(line);
				continue;
			}
			if (frame && typeof frame === "object" && !Array.isArray(frame)) onFrame(frame as Record<string, unknown>);
			else onInvalid(line);
		}
	});
}
