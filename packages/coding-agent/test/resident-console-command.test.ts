import { describe, expect, it } from "vitest";
import { parseResidentConsoleArgs } from "../src/cli/resident-console-command.ts";

describe("resident console command", () => {
	it("recognizes Supervisor and Architect console flags with optional initial prompts", () => {
		expect(parseResidentConsoleArgs(["--supervisor"])).toEqual({ service: "supervisor" });
		expect(parseResidentConsoleArgs(["--architect", "review", "this"])).toEqual({
			service: "architect",
			initialPrompt: "review this",
		});
	});

	it("leaves ordinary service and session commands unchanged", () => {
		expect(parseResidentConsoleArgs(["supervisor"])).toBeUndefined();
		expect(parseResidentConsoleArgs(["--model", "openai/gpt"])).toBeUndefined();
	});

	it("rejects resident console flags combined with normal CLI flags", () => {
		expect(() => parseResidentConsoleArgs(["--supervisor", "--model", "openai/gpt"])).toThrow("cannot be combined");
	});
});
