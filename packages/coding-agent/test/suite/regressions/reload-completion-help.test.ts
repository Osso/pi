import { expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../../src/core/slash-commands.ts";

it("mentions context files in reload completion help", () => {
	const reload = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "reload");
	expect(reload?.description).toContain("context files");
});
