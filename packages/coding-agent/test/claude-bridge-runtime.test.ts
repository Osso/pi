import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ isBunBinary: false, packageDir: "" }));
vi.mock("../src/config.ts", () => ({
	get isBunBinary() {
		return runtime.isBunBinary;
	},
	getPackageDir: () => runtime.packageDir,
}));

import { resolveClaudeCodeExecutable } from "../extensions/claude-bridge/src/bundled-runtime.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	runtime.isBunBinary = false;
});

describe("bundled Claude executable", () => {
	it("keeps an explicitly configured executable unchanged", () => {
		runtime.isBunBinary = true;
		expect(resolveClaudeCodeExecutable("/configured/claude")).toBe("/configured/claude");
	});

	it("lets the SDK select its npm platform package outside a compiled binary", () => {
		expect(resolveClaudeCodeExecutable()).toBeUndefined();
	});

	it("selects the executable shipped with a compiled Pi release", () => {
		runtime.isBunBinary = true;
		runtime.packageDir = mkdtempSync(join(tmpdir(), "pi-claude-binary-"));
		directories.push(runtime.packageDir);
		mkdirSync(join(runtime.packageDir, "claude"));
		const filename = process.platform === "win32" ? "claude.exe" : "claude";
		const executable = join(runtime.packageDir, "claude", filename);
		writeFileSync(executable, "fixture executable");
		expect(resolveClaudeCodeExecutable()).toBe(executable);
	});

	it("reports a missing release asset rather than using an unrelated Claude install", () => {
		runtime.isBunBinary = true;
		runtime.packageDir = mkdtempSync(join(tmpdir(), "pi-claude-missing-"));
		directories.push(runtime.packageDir);
		expect(() => resolveClaudeCodeExecutable()).toThrow("Bundled Claude Code executable is missing:");
	});
});
