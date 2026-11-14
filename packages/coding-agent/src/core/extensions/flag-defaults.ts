import type { Extension, ExtensionRuntime } from "./types.ts";

/**
 * Extensions loaded before the project trust decision register their flag defaults first, but the first
 * extension in the final load order owns each flag. Re-derive the defaults in that order.
 */
export function applyFlagDefaultsInOrder(extensions: Extension[], runtime: ExtensionRuntime): void {
	const owned = new Set<string>();
	for (const extension of extensions) {
		for (const [name, flag] of extension.flags) {
			if (owned.has(name)) continue;
			owned.add(name);
			if (flag.default === undefined) runtime.flagValues.delete(name);
			else runtime.flagValues.set(name, flag.default);
		}
	}
}
