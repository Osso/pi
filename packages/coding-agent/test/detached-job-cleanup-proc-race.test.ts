import type * as fs from "node:fs";
import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readLinuxProcessReferences } from "../src/core/detached-job-cleanup.ts";

// When a process exits while /proc is being listed, procfs reports its entry as DT_UNKNOWN.
// readdirSync(..., { withFileTypes: true }) then lstats that entry itself and throws ENOENT.
// Measured on Linux 6.x: about one such failure per 10 s of back-to-back /proc listings under fork churn.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	const readdirSync = ((path: fs.PathLike, options?: unknown) => {
		if (path === "/proc" && typeof options === "object" && options !== null && "withFileTypes" in options) {
			throw Object.assign(new Error("ENOENT: no such file or directory, lstat '/proc/4194303'"), {
				code: "ENOENT",
				syscall: "lstat",
				path: "/proc/4194303",
			});
		}
		return (actual.readdirSync as (path: fs.PathLike, options?: unknown) => unknown)(path, options);
	}) as typeof fs.readdirSync;
	return { ...actual, readdirSync, default: { ...actual, readdirSync } };
});

describe.runIf(process.platform === "linux")("detached-job /proc scan", () => {
	it("still lists live process references when a process exits during the /proc listing", () => {
		const references = readLinuxProcessReferences();

		expect(references?.has(realpathSync(process.cwd()))).toBe(true);
	});
});
