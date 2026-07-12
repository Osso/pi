import { describe, expect, it } from "vitest";
import {
	DETACHED_PYRUN_RUNNER_MODE,
	getDetachedPyrunRunnerInvocation,
} from "../extensions/pyrun/src/detached-runner.ts";
import { DETACHED_BASH_RUNNER_MODE, getDetachedBashRunnerInvocation } from "../src/core/detached-bash-runner.ts";

describe("detached runner launch modes", () => {
	it("launches the compiled Bash binary through its hidden runner mode", () => {
		expect(
			getDetachedBashRunnerInvocation("/tmp/bash/launch.json", {
				compiled: true,
				executablePath: "/tmp/pi",
			}),
		).toEqual({
			executable: "/tmp/pi",
			args: [DETACHED_BASH_RUNNER_MODE, "/tmp/bash/launch.json"],
		});
	});

	it("launches the compiled Pyrun binary through its hidden runner mode", () => {
		expect(
			getDetachedPyrunRunnerInvocation("/tmp/pyrun/launch.json", {
				compiled: true,
				executablePath: "/tmp/pi",
			}),
		).toEqual({
			executable: "/tmp/pi",
			args: [DETACHED_PYRUN_RUNNER_MODE, "/tmp/pyrun/launch.json"],
		});
	});

	it("keeps source entry-file invocation for Node and source tests", () => {
		expect(
			getDetachedBashRunnerInvocation("/tmp/bash/launch.json", {
				entryPath: "/repo/detached-bash-runner-entry.ts",
				executablePath: "/usr/bin/node",
			}),
		).toEqual({
			executable: "/usr/bin/node",
			args: ["--experimental-strip-types", "/repo/detached-bash-runner-entry.ts", "/tmp/bash/launch.json"],
		});
		expect(
			getDetachedPyrunRunnerInvocation("/tmp/pyrun/launch.json", {
				entryPath: "/repo/detached-runner-entry.mjs",
				executablePath: "/usr/bin/node",
			}),
		).toEqual({
			executable: "/usr/bin/node",
			args: ["/repo/detached-runner-entry.mjs", "/tmp/pyrun/launch.json"],
		});
	});
});
