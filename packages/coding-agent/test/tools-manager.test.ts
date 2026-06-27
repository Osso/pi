import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool, getToolPath } from "../src/utils/tools-manager.ts";

describe("tools manager", () => {
	let previousPath: string | undefined;
	let emptyPathDir: string | undefined;

	afterEach(() => {
		if (previousPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = previousPath;
		}
		if (emptyPathDir) {
			rmSync(emptyPathDir, { force: true, recursive: true });
			emptyPathDir = undefined;
		}
		vi.restoreAllMocks();
	});

	it("uses system tools only and never auto-downloads missing tools", async () => {
		previousPath = process.env.PATH;
		emptyPathDir = mkdtempSync(join(tmpdir(), "pi-tools-empty-path-"));
		process.env.PATH = emptyPathDir;
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(ensureTool("rg", true)).resolves.toBeUndefined();

		expect(getToolPath("rg")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
