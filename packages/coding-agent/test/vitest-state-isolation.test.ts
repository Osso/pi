import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ENV_STATE_DIR, getUserStateRoot } from "../src/config.ts";

describe("Vitest state isolation", () => {
	it("uses a temporary state root for the test run", () => {
		const stateDir = process.env[ENV_STATE_DIR];
		expect(stateDir).toBeDefined();
		expect(stateDir?.startsWith(tmpdir())).toBe(true);
		expect(stateDir).toContain("pi-vitest-state-");
		if (!stateDir) throw new Error("Missing isolated Vitest state directory");
		expect(getUserStateRoot()).toBe(stateDir);
		expect(existsSync(stateDir)).toBe(true);
	});
});
