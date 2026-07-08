import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, expandBuiltinSlashCommandInput } from "../src/core/slash-commands.ts";

describe("continue command", () => {
	it("registers /continue as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			description: "Send 'continue' to resume interrupted work",
			name: "continue",
		});
	});

	it("registers /effort as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			description: "Set model effort level (depends on selected model)",
			name: "effort",
		});
	});

	it("expands /continue to the normal continue prompt", () => {
		expect(expandBuiltinSlashCommandInput("/continue")).toBe("continue");
		expect(expandBuiltinSlashCommandInput("/continue with details")).toBe("/continue with details");
	});
});
