import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";

it.each([
	{ args: ["--mode"], verbose: undefined, messages: [] },
	{ args: ["--mode", "--verbose", "hello"], verbose: true, messages: ["hello"] },
	{ args: ["--mode", "--", "--literal"], verbose: undefined, messages: ["--literal"] },
])("rejects --mode with no value in $args without consuming the next option", ({ args, verbose, messages }) => {
	const result = parseArgs(args);
	expect(result.mode).toBeUndefined();
	expect(result.diagnostics).toEqual([{ type: "error", message: "--mode requires text, json, or rpc" }]);
	expect(result.verbose).toBe(verbose);
	expect(result.messages).toEqual(messages);
});
