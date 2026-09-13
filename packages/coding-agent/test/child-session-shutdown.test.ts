import { expect, it } from "vitest";
import { bindProductionChildSession } from "../extensions/agents-core/src/child-session.ts";

it("keeps child resources valid until asynchronous shutdown cleanup finishes", async () => {
	const gate = Promise.withResolvers<void>();
	let resourcesOpen = true;
	let cleanupUsedLiveResources = false;
	const child = bindProductionChildSession({
		bindExtensions: async () => {},
		extensionRunner: {
			async emit() {
				await gate.promise;
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
	gate.resolve();
	await shutdown;
	expect(cleanupUsedLiveResources).toBe(true);
	expect(resourcesOpen).toBe(false);
});
