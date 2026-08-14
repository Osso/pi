import type { CanonicalPyrunEvalResult, CanonicalPyrunProgressUpdate } from "./runner.ts";

export type PyrunArtifactRecord =
	| { kind: "error"; error: string }
	| { kind: "progress"; update: CanonicalPyrunProgressUpdate }
	| { kind: "result"; result: CanonicalPyrunEvalResult };

export type ConsoleProgressUpdate = CanonicalPyrunProgressUpdate & { text: string; type: "console" };

export interface ConsoleProgressBatch {
	text: string[];
	update?: ConsoleProgressUpdate;
}

export function isConsoleProgressUpdate(update: CanonicalPyrunProgressUpdate): update is ConsoleProgressUpdate {
	return update.type === "console" && typeof update.text === "string";
}

export interface ArtifactProgressAccumulator {
	consume(records: PyrunArtifactRecord[]): CanonicalPyrunEvalResult | undefined;
	close(): void;
}

const DENSE_CONSOLE_RECORD_THRESHOLD = 100;

export function createArtifactProgressAccumulator(
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
	flushDelayMs: number,
): ArtifactProgressAccumulator {
	let pendingUpdates: ConsoleProgressUpdate[] = [];
	let pendingStream: string | undefined;
	let denseBatch: ConsoleProgressBatch | undefined;
	let flushTimer: NodeJS.Timeout | undefined;

	const clearFlushTimer = (): void => {
		if (!flushTimer) return;
		clearTimeout(flushTimer);
		flushTimer = undefined;
	};

	const resetPending = (): void => {
		pendingUpdates = [];
		pendingStream = undefined;
		denseBatch = undefined;
	};

	const flush = (): void => {
		clearFlushTimer();
		if (denseBatch?.update) {
			reportProgress({ ...denseBatch.update, text: denseBatch.text.join("") });
		} else {
			for (const update of pendingUpdates) reportProgress(update);
		}
		resetPending();
	};

	const scheduleFlush = (): void => {
		if (flushTimer) return;
		flushTimer = setTimeout(flush, flushDelayMs);
	};

	const consumeConsoleUpdate = (update: ConsoleProgressUpdate): void => {
		if (pendingStream !== undefined && pendingStream !== update.stream) flush();
		pendingStream ??= update.stream;
		if (denseBatch) {
			denseBatch.update = update;
			denseBatch.text.push(update.text);
		} else {
			pendingUpdates.push(update);
			if (pendingUpdates.length >= DENSE_CONSOLE_RECORD_THRESHOLD) {
				denseBatch = {
					text: pendingUpdates.map((pendingUpdate) => pendingUpdate.text),
					update,
				};
				pendingUpdates = [];
			}
		}
		scheduleFlush();
	};

	return {
		consume: (records) => {
			let result: CanonicalPyrunEvalResult | undefined;
			for (const record of records) {
				if (record.kind === "progress") {
					if (isConsoleProgressUpdate(record.update)) {
						consumeConsoleUpdate(record.update);
					} else {
						flush();
						reportProgress(record.update);
					}
					continue;
				}
				flush();
				if (record.kind === "result") result = record.result;
			}
			return result;
		},
		close: () => {
			clearFlushTimer();
			resetPending();
		},
	};
}
