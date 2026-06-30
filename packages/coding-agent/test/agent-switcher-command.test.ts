import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("agent switcher command", () => {
	it("registers /agents as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			description: "Open agent switcher",
			name: "agents",
		});
	});
});
