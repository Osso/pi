import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("built-in commands", () => {
	it("registers /cd as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			description: "Move the current session to another working directory",
			name: "cd",
		});
	});

	it("registers /continue as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			description: "Continue from the current transcript without adding a user message",
			name: "continue",
		});
	});
});
