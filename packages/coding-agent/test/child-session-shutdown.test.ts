import { expect, it } from "vitest";
import { bindProductionChildSession } from "../extensions/agents-core/src/child-session.ts";

it("keeps child resources valid until asynchronous shutdown cleanup finishes", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let resourcesOpen = true;
	let cleanupUsedLiveResources = false;
	const child = bindProductionChildSession({
		bindExtensions: async () => {},
		extensionRunner: {
			async emit() {
				await gate;
				cleanupUsedLiveResources = resourcesOpen;
			},
		},
		dispose: () => {
			resourcesOpen = false;
		},
		messages: [],
		prompt: async () => {},
	});

	const shutdown = child.dispose?.();
	expect(resourcesOpen).toBe(true);
	if (!release) throw new Error("Shutdown cleanup barrier was not initialized");
	release();
	await shutdown;
	expect(cleanupUsedLiveResources).toBe(true);
	expect(resourcesOpen).toBe(false);
});
