import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const testScriptPath = resolve(import.meta.dirname, "../../../test.sh");

describe("repository test runner isolation", () => {
	test("uses a unique agent directory without moving global authentication", () => {
		const script = readFileSync(testScriptPath, "utf8");

		expect(script).toContain("mktemp -d");
		expect(script).toContain('export PI_CODING_AGENT_DIR="$TEST_AGENT_DIR"');
		expect(script).not.toContain("auth.json");
		expect(script).not.toContain("AUTH_BACKUP");
	});
});
