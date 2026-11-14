import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";

/** The UI of the current Pi session; importers read this live binding, only setPiUI writes it. */
export let piUI: ExtensionUIContext | null = null;

export function setPiUI(ui: ExtensionUIContext | null): void {
	piUI = ui;
}
