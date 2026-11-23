import { EventEmitter } from "node:events";
import type { ExtensionRuntimeState } from "./extensions/types.ts";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}

export interface ReloadableEventBus extends EventBus {
	/** Starts a new extension set and returns a function that removes the listeners the previous set added. */
	renew(): () => void;
}

/** A view of `bus` for the loaded extension set. Listeners added straight to `bus` survive every reload. */
export function createReloadableEventBus(bus: EventBus): ReloadableEventBus {
	let removers = new Set<() => void>();
	return {
		emit: (channel, data) => bus.emit(channel, data),
		on: (channel, handler) => {
			const owner = removers;
			const off = bus.on(channel, handler);
			const remove = () => {
				owner.delete(remove);
				off();
			};
			owner.add(remove);
			return remove;
		},
		renew: () => {
			const previous = removers;
			removers = new Set();
			return () => {
				for (const remove of [...previous]) remove();
			};
		},
	};
}

/**
 * One extension's `pi.events`. A throwing handler goes to `runtime.reportError` like other extension
 * errors; console.error would draw over the interactive TUI. Before the runner sets a reporter, the
 * shared bus logs the error as before.
 */
export function createExtensionEventBus(
	bus: EventBus,
	extensionPath: string,
	runtime: Pick<ExtensionRuntimeState, "reportError">,
): EventBus {
	return {
		emit: (channel, data) => bus.emit(channel, data),
		on: (channel, handler) =>
			bus.on(channel, async (data) => {
				try {
					await handler(data);
				} catch (error) {
					if (!runtime.reportError) throw error;
					runtime.reportError({
						extensionPath,
						event: `events:${channel}`,
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}),
	};
}
