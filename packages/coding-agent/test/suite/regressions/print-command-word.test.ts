import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";

it.each(["tools", "extensions", "login"])("processes %s as prompt text after a print option and flag", (word) => {
	const result = parseArgs(["-p", "--verbose", word]);
	expect(result.messages).toEqual([word]);
	expect(result.diagnostics).toEqual([]);
	expect(result.listTools).toBeUndefined();
	expect(result.listExtensions).toBeUndefined();
	expect(result.loginProvider).toBeUndefined();
});
