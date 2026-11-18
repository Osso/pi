import type { EventBus } from "../event-bus.ts";
import type { ExtensionRuntime } from "./types.ts";

/**
 * Record what an extension factory is about to register, so a factory that throws leaves nothing behind:
 * no flags, flag values, provider registrations or `pi.events` listeners.
 */
export function captureFactoryRegistrations(
	runtime: ExtensionRuntime,
	flagNames: Set<string>,
	eventBus: EventBus,
): { eventBus: EventBus; rollback(): void } {
	const previousNames = new Set(flagNames);
	const previousValues = new Map(runtime.flagValues);
	const previousProviders = [...runtime.pendingProviderRegistrations];
	const removeListeners: Array<() => void> = [];
	const trackedBus: EventBus = {
		emit: (channel, data) => eventBus.emit(channel, data),
		on: (channel, handler) => {
			const remove = eventBus.on(channel, handler);
			removeListeners.push(remove);
			return remove;
		},
	};
	return {
		eventBus: trackedBus,
		rollback: () => {
			for (const remove of removeListeners.splice(0)) remove();
			for (const name of flagNames) if (!previousNames.has(name)) flagNames.delete(name);
			runtime.flagValues = previousValues;
			runtime.pendingProviderRegistrations = previousProviders;
		},
	};
}
