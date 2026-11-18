import type { Readable } from "node:stream";
import { attachJsonlLineReader } from "./jsonl.ts";
import type { RpcExtensionUIResponse } from "./rpc-types.ts";

/**
 * Read RPC input from process start, so a dialog opened by a `session_start` handler receives its
 * `extension_ui_response`. Until `start()`, other lines are queued and EOF is held; `start()` replays them.
 */
export function readRpcInputFromStartup(
	stream: Readable,
	resolveStartupDialog: (response: RpcExtensionUIResponse) => void,
): { start(onLine: (line: string) => void, onEnd: () => void): () => void } {
	let queuedLines: string[] = [];
	let inputEnded = false;
	let handleLine = (line: string): void => {
		const response = parseExtensionUiResponse(line);
		if (response) resolveStartupDialog(response);
		else queuedLines.push(line);
	};
	let handleEnd = (): void => {
		inputEnded = true;
	};
	const detachLines = attachJsonlLineReader(stream, (line) => handleLine(line));
	const onStreamEnd = (): void => handleEnd();
	stream.on("end", onStreamEnd);
	return {
		start(onLine, onEnd) {
			handleLine = onLine;
			handleEnd = onEnd;
			const lines = queuedLines;
			queuedLines = [];
			for (const line of lines) onLine(line);
			if (inputEnded) onEnd();
			return () => {
				detachLines();
				stream.off("end", onStreamEnd);
			};
		},
	};
}

/** Malformed lines are not dialog responses; they stay queued and are reported once commands run. */
function parseExtensionUiResponse(line: string): RpcExtensionUIResponse | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const isResponse =
		typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "extension_ui_response";
	return isResponse ? (parsed as RpcExtensionUIResponse) : undefined;
}
