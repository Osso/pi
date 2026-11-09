import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, isBunBinary } from "../../../src/config.ts";

/** Compiled Pi ships the SDK executable next to its other runtime assets. */
export function resolveClaudeCodeExecutable(configured?: string): string | undefined {
	if (configured !== undefined) return configured;
	if (!isBunBinary) return undefined;
	const filename = process.platform === "win32" ? "claude.exe" : "claude";
	const executable = join(getPackageDir(), "claude", filename);
	if (!existsSync(executable)) {
		throw new Error(`Bundled Claude Code executable is missing: ${executable}`);
	}
	return executable;
}
