import { afterEach, expect, it, vi } from "vitest";
import { formatContextPath, formatDisplayPath } from "../src/modes/interactive/loaded-resources-format.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

it("abbreviates only paths inside the home directory", () => {
	vi.stubEnv("HOME", "/home/alex");

	expect(formatDisplayPath("/home/alex/.pi/AGENTS.md")).toBe("~/.pi/AGENTS.md");
	expect(formatDisplayPath("/home/alex")).toBe("~");
	expect(formatDisplayPath("extensions/index.ts")).toBe("extensions/index.ts");
	// A sibling directory that only shares the home prefix keeps its full path.
	expect(formatContextPath("/home/alex-work/AGENTS.md", "/home/alex-work/project")).toBe("/home/alex-work/AGENTS.md");
});
