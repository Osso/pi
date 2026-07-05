export interface ToolDetachHandle {
	detach(): boolean;
}

export interface ToolDetachRegistryOptions {
	autoDetachAfterMs?: number;
}

export const DEFAULT_AUTO_DETACH_AFTER_MS = 120_000;

export class ToolDetachRegistry {
	private readonly autoDetachAfterMs: number;
	private readonly handles = new Set<ToolDetachHandle>();
	private readonly timers = new Map<ToolDetachHandle, NodeJS.Timeout>();

	constructor(options: ToolDetachRegistryOptions = {}) {
		this.autoDetachAfterMs = options.autoDetachAfterMs ?? DEFAULT_AUTO_DETACH_AFTER_MS;
	}

	register(handle: ToolDetachHandle): () => void {
		this.handles.add(handle);
		this.startAutoDetachTimer(handle);
		return () => this.unregister(handle);
	}

	detachRunning(): boolean {
		const handles = [...this.handles].reverse();
		for (const handle of handles) {
			if (handle.detach()) {
				return true;
			}
		}
		return false;
	}

	hasRunning(): boolean {
		return this.handles.size > 0;
	}

	private startAutoDetachTimer(handle: ToolDetachHandle): void {
		const timer = setTimeout(() => {
			if (this.handles.has(handle)) {
				handle.detach();
			}
		}, this.autoDetachAfterMs);
		timer.unref?.();
		this.timers.set(handle, timer);
	}

	private unregister(handle: ToolDetachHandle): void {
		this.handles.delete(handle);
		const timer = this.timers.get(handle);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(handle);
		}
	}
}
