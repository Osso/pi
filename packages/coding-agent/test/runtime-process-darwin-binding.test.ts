import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

interface ProcessBinding {
	readProcessInfo(pid: unknown): { pid: number; startTimeTicks: number; state: string; processGroupId: number };
}

const requireNative = createRequire(import.meta.url);
const source = fileURLToPath(new URL("../native/darwin/src/process-info.c", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/darwin-process-sdk/", import.meta.url));
let directory: string;
let binding: ProcessBinding;
let nativePath: string;

describe.runIf(process.platform === "linux")("Darwin native bridge with a controlled kernel boundary", () => {
	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-darwin-napi-"));
		const output = join(directory, "process-info.node");
		nativePath = output;
		const compiled = spawnSync(
			"cc",
			[
				"-shared",
				"-fPIC",
				"-std=c11",
				"-Wall",
				"-Wextra",
				"-Werror",
				"-I",
				fixture,
				source,
				join(fixture, "mock-libproc.c"),
				"-o",
				output,
			],
			{ encoding: "utf8" },
		);
		if (compiled.status !== 0) throw new Error(`Native fixture compilation failed: ${compiled.stderr}`);
		binding = requireNative(output) as ProcessBinding;
	});
	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	test("returns native creation time, process state and group through Node N-API", () => {
		expect(binding.readProcessInfo(4200)).toEqual({
			pid: 4200,
			startTimeTicks: 1_792_000_000_123_456,
			state: "R",
			processGroupId: 5300,
		});
		expect(binding.readProcessInfo(4201).state).toBe("Z");
	});

	test("loads the same native bridge through Bun without changing its identity or error contract", () => {
		const result = spawnSync("bun", [join(fixture, "bun-probe.mjs"), nativePath], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.live).toEqual({
			pid: 4200,
			startTimeTicks: 1_792_000_000_123_456,
			state: "R",
			processGroupId: 5300,
		});
		expect(report.zombie.state).toBe("Z");
		expect(report.errors).toEqual({ 4202: "ESRCH", 4203: "EPERM", 4204: "EIO", 4205: "ERANGE", 4206: "ERANGE" });
	});

	for (const [pid, code] of [
		[4202, "ESRCH"],
		[4203, "EPERM"],
		[4204, "EIO"],
		[4205, "ERANGE"],
		[4206, "ERANGE"],
	] as const) {
		test(`reports ${code} without inventing an identity for PID ${pid}`, () => {
			expect(() => binding.readProcessInfo(pid)).toThrow();
			try {
				binding.readProcessInfo(pid);
			} catch (error) {
				expect((error as NodeJS.ErrnoException).code).toBe(code);
			}
		});
	}

	for (const argument of [0, -1, 1.5, Number.NaN, "4200", undefined]) {
		test(`rejects invalid PID argument ${String(argument)}`, () => {
			expect(() => binding.readProcessInfo(argument)).toThrow(/PID/i);
		});
	}
});
