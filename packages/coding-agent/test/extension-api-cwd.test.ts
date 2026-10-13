import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

describe("ExtensionAPI.cwd", () => {
	it("supplies factory cwd before session start or core binding", async () => {
		const runtime = createExtensionRuntime();
		let factoryCwd: string | undefined;
		await loadExtensionFromFactory(
			(pi) => {
				factoryCwd = pi.cwd;
				pi.registerProvider("cwd-provider", { baseUrl: `file://${pi.cwd}` });
			},
			"/tmp/factory-project",
			createEventBus(),
			runtime,
		);
		expect(factoryCwd).toBe("/tmp/factory-project");
		expect(runtime.pendingProviderRegistrations[0]?.config.baseUrl).toBe("file:///tmp/factory-project");
	});

	it("binds each API instance to its loader cwd and rejects reads after invalidation", async () => {
		const firstRuntime = createExtensionRuntime();
		const secondRuntime = createExtensionRuntime();
		const apis: ExtensionAPI[] = [];
		const factory = (pi: ExtensionAPI) => {
			apis.push(pi);
		};
		await loadExtensionFromFactory(factory, "/tmp/first-project", createEventBus(), firstRuntime);
		await loadExtensionFromFactory(factory, "/tmp/second-project", createEventBus(), secondRuntime);
		expect(apis[0].cwd).toBe("/tmp/first-project");
		expect(apis[1].cwd).toBe("/tmp/second-project");
		firstRuntime.invalidate("replaced instance");
		expect(() => apis[0].cwd).toThrow("replaced instance");
		expect(apis[1].cwd).toBe("/tmp/second-project");
	});
});
