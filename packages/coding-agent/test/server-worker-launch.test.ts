import { describe, expect, it } from "vitest";
import { workerLaunchPrefix } from "../src/cli/server-launch.ts";

describe("pi server worker launch", () => {
	it("passes only CLI arguments to the compiled binary", () => {
		// Bun compile reports argv ["bun", "/$bunfs/root/pi", "server"] and no execArgv.
		expect(workerLaunchPrefix(true, ["bun", "/$bunfs/root/pi", "server"], [])).toEqual([]);
	});

	it("runs the source entry point with the runtime flags from source", () => {
		expect(
			workerLaunchPrefix(false, ["/usr/bin/node", "/repo/src/cli.ts", "server"], ["--experimental-strip-types"]),
		).toEqual(["--experimental-strip-types", "/repo/src/cli.ts"]);
	});
});
