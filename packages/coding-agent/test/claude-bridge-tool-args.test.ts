import { describe, expect, it } from "vitest";
import { mapToolArgs } from "../extensions/claude-bridge/src/stream-events.ts";

describe("Claude bridge tool arguments", () => {
	it("passes bash calls through without inventing a timeout", () => {
		// Pi bash has no default timeout and backgrounds long commands; a bridge-added
		// timeout killed test suites and builds after two minutes.
		expect(mapToolArgs("bash", { command: "npm test" })).toEqual({ command: "npm test" });
	});

	it("keeps a timeout the model chose", () => {
		expect(mapToolArgs("bash", { command: "sleep 5", timeout: 30 })).toEqual({ command: "sleep 5", timeout: 30 });
	});

	it("renames Claude Code parameter names to pi's", () => {
		expect(mapToolArgs("read", { file_path: "a.ts" })).toEqual({ path: "a.ts" });
	});

	it("passes through arguments named like Object.prototype members", () => {
		expect(mapToolArgs("inspect_schema", { toString: "decimal", constructor: "Money", format: "short" })).toEqual({
			toString: "decimal",
			constructor: "Money",
			format: "short",
		});
	});
});
