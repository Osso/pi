import { describe, expect, it } from "vitest";
import { getLanguageFromPath } from "../src/modes/interactive/theme/theme.ts";

describe("getLanguageFromPath", () => {
	it.each([
		["/repo/Dockerfile", "dockerfile"],
		["tools/Makefile", "makefile"],
		["/repo.v2/src/main.ts", "typescript"],
		["/repo.v2/README", undefined],
	])("detects the language of %s from its file name", (filePath, language) => {
		expect(getLanguageFromPath(filePath)).toBe(language);
	});
});
