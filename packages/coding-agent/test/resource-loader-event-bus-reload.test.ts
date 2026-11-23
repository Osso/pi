import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

describe("DefaultResourceLoader reload and pi.events", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("delivers each event once to the reloaded extensions and keeps listeners added directly to the bus", async () => {
		const receivedKey = `__reloadEvents_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const extensionPath = join(cwd, "listener.ts");
		writeFileSync(
			extensionPath,
			`export default function(pi) {
				pi.events.on("ping", (data) => {
					(globalThis[${JSON.stringify(receivedKey)}] ??= []).push("file:" + data);
				});
			}`,
		);
		const received: string[] = [];
		const inlineListener: ExtensionFactory = (pi) => {
			pi.events.on("ping", (data) => {
				received.push(`inline:${String(data)}`);
			});
		};
		const eventBus = createEventBus();
		eventBus.on("ping", (data) => {
			received.push(`host:${String(data)}`);
		});
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			eventBus,
			additionalExtensionPaths: [extensionPath],
			extensionFactories: [inlineListener],
		});

		await loader.reload();
		eventBus.emit("ping", "before");
		await loader.reload();
		await loader.reload();
		eventBus.emit("ping", "after");
		await new Promise((resolve) => setImmediate(resolve));

		const fileReceived = (globalThis as Record<string, unknown>)[receivedKey];
		expect(fileReceived).toEqual(["file:before", "file:after"]);
		expect(received).toEqual(["host:before", "inline:before", "host:after", "inline:after"]);
	});
});
