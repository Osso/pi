import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";

describe("createAgentSessionServices extension flag values", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		[false, false],
		[true, true],
	])("keeps an explicit boolean %s for a boolean flag that defaults to true", async (value, expected) => {
		const root = mkdtempSync(join(tmpdir(), "pi-services-flags-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });

		const services = await createAgentSessionServices({
			cwd: root,
			agentDir,
			extensionFlagValues: new Map([["enabled", value]]),
			resourceLoaderOptions: {
				extensionFactories: [(pi) => pi.registerFlag("enabled", { type: "boolean", default: true })],
			},
		});

		expect(services.diagnostics).toEqual([]);
		expect(services.resourceLoader.getExtensions().runtime.flagValues.get("enabled")).toBe(expected);
	});
});
