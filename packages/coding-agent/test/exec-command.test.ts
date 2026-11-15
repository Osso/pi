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
});
