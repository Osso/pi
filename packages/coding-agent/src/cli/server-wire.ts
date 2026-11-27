import { hostname } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createJsonlLineSplitter } from "../modes/rpc/jsonl.ts";

/** One frame carries a whole attach snapshot (`get_messages` of a long session), so the limit only stops runaway output. */
export const MAX_FRAME_BYTES = 64 * 1_048_576;

type FrameSink = Pick<Writable, "destroyed" | "writableLength" | "write" | "destroy">;

export function serverHostId(): string {
	return process.env.PI_SERVER_HOST_ID || hostname();
}

/**
 * Default spoke link. A non-interactive SSH shell often lacks ~/.local/bin on PATH, so the remote pi is named by
 * its install path; the remote shell expands `~`. Set `server.hubCommand` when pi is installed elsewhere.
 */
export function defaultHubCommand(hub: string): string[] {
	return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", hub, "~/.local/bin/pi", "server", "--link"];
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
		sink.destroy(new Error("Output buffer exceeds 64 MiB"));
		return;
	}
	sink.write(line);
}

/** Calls onFrame for every JSONL object on the stream; destroys the stream on a frame over 64 MiB. */
export function readFrames(
	stream: Readable,
	onFrame: (frame: Record<string, unknown>) => void,
	onInvalid: (line: string) => void,
): void {
	stream.setEncoding("utf8");
	const tooLarge = () => stream.destroy(new Error("Frame exceeds 64 MiB"));
	const splitter = createJsonlLineSplitter((line) => {
		if (stream.destroyed || !line.trim()) return;
		if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return tooLarge();
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return onInvalid(line);
		}
		if (frame && typeof frame === "object" && !Array.isArray(frame)) onFrame(frame as Record<string, unknown>);
		else onInvalid(line);
	});
	stream.on("data", (chunk: string | Buffer) => {
		splitter.write(chunk);
		if (splitter.pendingBytes() > MAX_FRAME_BYTES) tooLarge();
	});
}
