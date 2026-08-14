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

class ArtifactProgressAccumulatorImpl implements ArtifactProgressAccumulator {
	private pendingUpdates: ConsoleProgressUpdate[] = [];
	private pendingStream: string | undefined;
	private denseBatch: ConsoleProgressBatch | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	private readonly reportProgress: (update: CanonicalPyrunProgressUpdate) => void;
	private readonly flushDelayMs: number;

	constructor(
		reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
		flushDelayMs: number,
	) {
		this.reportProgress = reportProgress;
		this.flushDelayMs = flushDelayMs;
	}

	consume(records: PyrunArtifactRecord[]): CanonicalPyrunEvalResult | undefined {
		let result: CanonicalPyrunEvalResult | undefined;
		for (const record of records) result = this.consumeRecord(record) ?? result;
		return result;
	}

	close(): void {
		this.clearFlushTimer();
		this.resetPending();
	}

	private consumeRecord(record: PyrunArtifactRecord): CanonicalPyrunEvalResult | undefined {
		if (record.kind === "progress") {
			this.consumeProgress(record.update);
			return undefined;
		}
		this.flush();
		return record.kind === "result" ? record.result : undefined;
	}

	private consumeProgress(update: CanonicalPyrunProgressUpdate): void {
		if (!isConsoleProgressUpdate(update)) {
			this.flush();
			this.reportProgress(update);
			return;
		}
		this.consumeConsoleUpdate(update);
	}

	private consumeConsoleUpdate(update: ConsoleProgressUpdate): void {
		this.flushForStreamChange(update);
		this.pendingStream ??= update.stream;
		if (this.denseBatch) this.appendDenseUpdate(update);
		else this.appendPendingUpdate(update);
		this.scheduleFlush();
	}

	private flushForStreamChange(update: ConsoleProgressUpdate): void {
		if (this.pendingStream !== undefined && this.pendingStream !== update.stream) this.flush();
	}

	private appendDenseUpdate(update: ConsoleProgressUpdate): void {
		const denseBatch = this.denseBatch;
		if (!denseBatch) return;
		denseBatch.text.push(update.text);
		denseBatch.update = update;
	}

	private appendPendingUpdate(update: ConsoleProgressUpdate): void {
		this.pendingUpdates.push(update);
		if (this.pendingUpdates.length < DENSE_CONSOLE_RECORD_THRESHOLD) return;
		this.denseBatch = { text: this.pendingUpdates.map((item) => item.text), update };
		this.pendingUpdates = [];
	}

	private flush(): void {
		this.clearFlushTimer();
		if (this.denseBatch?.update) this.reportDenseBatch();
		else this.reportPendingUpdates();
		this.resetPending();
	}

	private reportDenseBatch(): void {
		if (!this.denseBatch?.update) return;
		this.reportProgress({ ...this.denseBatch.update, text: this.denseBatch.text.join("") });
	}

	private reportPendingUpdates(): void {
		for (const update of this.pendingUpdates) this.reportProgress(update);
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
	}

	private clearFlushTimer(): void {
		if (!this.flushTimer) return;
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}

	private resetPending(): void {
		this.pendingUpdates = [];
		this.pendingStream = undefined;
		this.denseBatch = undefined;
	}
}

export function createArtifactProgressAccumulator(
	reportProgress: (update: CanonicalPyrunProgressUpdate) => void,
	flushDelayMs: number,
): ArtifactProgressAccumulator {
	return new ArtifactProgressAccumulatorImpl(reportProgress, flushDelayMs);
}
