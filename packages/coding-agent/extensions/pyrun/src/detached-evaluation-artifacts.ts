import type { FSWatcher } from "node:fs";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { closeWatcher, watchWithErrorHandler } from "../../../src/utils/fs-watch.ts";
import type { PyrunArtifactRecord } from "./detached-progress.ts";

export const ARTIFACT_POLL_MS = 1_000;
const ARTIFACT_READ_BYTE_LIMIT = 1_048_576;
interface ArtifactWakeup {
	wait(): Promise<void>;
	close(): void;
}

class ArtifactWakeupController implements ArtifactWakeup {
	private watcher: FSWatcher | null;
	private pendingResolve: (() => void) | undefined;
	private fallbackTimer: NodeJS.Timeout | undefined;
	private wakePending = false;
	private closed = false;

	constructor(directory: string) {
		this.watcher = watchWithErrorHandler(
			directory,
			() => this.handleActivity(),
			() => this.handleWatchError(),
		);
	}

	wait(): Promise<void> {
		if (this.closed || this.wakePending) {
			this.wakePending = false;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.startWait(resolve));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		closeWatcher(this.watcher);
		this.watcher = null;
		this.resolvePendingWait();
	}

	private startWait(resolve: () => void): void {
		this.pendingResolve = resolve;
		this.fallbackTimer = setTimeout(() => this.resolvePendingWait(), ARTIFACT_POLL_MS);
	}

	private handleActivity(): void {
		this.wakePending = true;
		this.resolvePendingWait();
	}

	private handleWatchError(): void {
		closeWatcher(this.watcher);
		this.watcher = null;
	}

	private resolvePendingWait(): void {
		const resolve = this.pendingResolve;
		this.pendingResolve = undefined;
		this.clearFallbackTimer();
		resolve?.();
	}

	private clearFallbackTimer(): void {
		if (!this.fallbackTimer) return;
		clearTimeout(this.fallbackTimer);
		this.fallbackTimer = undefined;
	}
}

export function createArtifactWakeup(directory: string): ArtifactWakeup {
	return new ArtifactWakeupController(directory);
}

export async function waitForArtifactActivity(artifactWakeup: ArtifactWakeup, hasUnreadBytes: boolean): Promise<void> {
	if (hasUnreadBytes) return;
	await artifactWakeup.wait();
}

export interface JsonLineReadCursor {
	fragments: Buffer[];
	fragmentBytes: number;
	offset: number;
}

export function createJsonLineReadCursor(): JsonLineReadCursor {
	return { fragments: [], fragmentBytes: 0, offset: 0 };
}

export interface JsonLineReadResult<T> {
	hasUnreadBytes: boolean;
	values: T[];
}

export function readNewJsonLines<T>(path: string, cursor: JsonLineReadCursor): T[] {
	return readJsonLineChunk<T>(path, cursor).values;
}

function readJsonLineChunk<T>(path: string, cursor: JsonLineReadCursor, byteLimit?: number): JsonLineReadResult<T> {
	if (!existsSync(path)) return { hasUnreadBytes: false, values: [] };
	const descriptor = openSync(path, "r");
	try {
		const size = fstatSync(descriptor).size;
		if (size <= cursor.offset) return { hasUnreadBytes: false, values: [] };
		const unreadBytes = size - cursor.offset;
		const bytesToRead = byteLimit === undefined ? unreadBytes : Math.min(unreadBytes, byteLimit);
		const data = Buffer.allocUnsafe(bytesToRead);
		const bytesRead = readSync(descriptor, data, 0, data.length, cursor.offset);
		cursor.offset += bytesRead;
		return {
			hasUnreadBytes: cursor.offset < size,
			values: consumeJsonLineBytes<T>(cursor, data.subarray(0, bytesRead)),
		};
	} finally {
		closeSync(descriptor);
	}
}

function consumeJsonLineBytes<T>(cursor: JsonLineReadCursor, data: Buffer): T[] {
	const values: T[] = [];
	let start = 0;
	for (;;) {
		const newline = data.indexOf(0x0a, start);
		if (newline === -1) break;
		const fragment = data.subarray(start, newline);
		const line =
			cursor.fragmentBytes === 0
				? fragment
				: Buffer.concat([...cursor.fragments, fragment], cursor.fragmentBytes + fragment.length);
		cursor.fragments = [];
		cursor.fragmentBytes = 0;
		if (line.length > 0) values.push(JSON.parse(line.toString("utf8")) as T);
		start = newline + 1;
	}
	if (start < data.length) {
		const fragment = data.subarray(start);
		cursor.fragments.push(fragment);
		cursor.fragmentBytes += fragment.length;
	}
	return values;
}

export function readNewArtifactRecords(
	path: string,
	cursor: JsonLineReadCursor,
): JsonLineReadResult<PyrunArtifactRecord> {
	return readJsonLineChunk<PyrunArtifactRecord>(path, cursor, ARTIFACT_READ_BYTE_LIMIT);
}
