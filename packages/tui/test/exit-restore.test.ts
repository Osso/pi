import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

// Mode switches the TUI turns on, paired with the sequence that turns each off again.
const MODES = [
	{ name: "hidden cursor", on: "\x1b[?25l", off: "\x1b[?25h" },
	{ name: "bracketed paste", on: "\x1b[?2004h", off: "\x1b[?2004l" },
	{ name: "modifyOtherKeys", on: "\x1b[>4;2m", off: "\x1b[>4;0m" },
	{ name: "Kitty keyboard protocol", on: "\x1b[>7u", off: "\x1b[<u" },
];

it("restores terminal modes when the process exits without stop()", { skip: process.platform === "win32" }, () => {
	const result = spawnSync(
		"python3",
		[`${fixtures}pty-capture.py`, process.execPath, `${fixtures}exit-without-stop.ts`],
		{ timeout: 15_000 },
	);
	assert.equal(result.status, 3, result.stderr.toString());
	const output = result.stdout.toString("latin1");
	assert.ok(output.includes("\x1b[?25l"), "the TUI hid the cursor while running");
	for (const mode of MODES) {
		const lastOn = output.lastIndexOf(mode.on);
		if (lastOn === -1) continue;
		assert.ok(output.lastIndexOf(mode.off) > lastOn, `${mode.name} is still on after exit`);
	}
});
