import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	// https://github.com/earendil-works/pi/issues/11312
	it("decodes a UTF-8 character split across output chunks", async () => {
		const script = `
			const bytes = Buffer.from("你好");
			for (const stream of [process.stdout, process.stderr]) stream.write(bytes.subarray(0, 1));
			setTimeout(() => {
				for (const stream of [process.stdout, process.stderr]) stream.write(bytes.subarray(1));
			}, 50);
		`;

		const result = await execCommand(process.execPath, ["-e", script], process.cwd());

		expect(result).toMatchObject({ stdout: "你好", stderr: "你好", code: 0 });
	});

	// https://github.com/earendil-works/pi/issues/11085
	it("reports spawn errors in stderr", async () => {
		const result = await execCommand("pi-command-that-does-not-exist-11085", [], process.cwd());

		expect(result).toMatchObject({ code: 1, killed: false, stdout: "" });
		expect(result.stderr).toMatch(/ENOENT/);
	});

	it("keeps stderr empty when a command exits silently", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(1)"], process.cwd());

		expect(result).toEqual({ stdout: "", stderr: "", code: 1, killed: false });
	});
});
