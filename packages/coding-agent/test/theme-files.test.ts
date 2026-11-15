import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadThemeFromPath,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

const darkTheme = JSON.parse(
	readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
) as { name: string; colors: Record<string, string | number> };

function writeTheme(path: string, name: string, accent: string | number): void {
	writeFileSync(path, JSON.stringify({ ...darkTheme, name, colors: { ...darkTheme.colors, accent } }, null, 2));
}

describe("custom theme files", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-files-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tempRoot, "agent"));
		mkdirSync(join(tempRoot, "agent", "themes"), { recursive: true });
	});

	afterEach(() => {
		stopThemeWatcher();
		setTheme("dark");
		setRegisteredThemes([]);
		rmSync(tempRoot, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it.each(["#12345g", "#ff0g00", "#-1ff00"])("rejects the invalid hex color %s", (accent) => {
		const themePath = join(tempRoot, "bad.json");
		writeTheme(themePath, "bad", accent);

		expect(() => loadThemeFromPath(themePath, "truecolor")).toThrow(`Invalid hex color: ${accent}`);
	});

	it("reloads the active theme from the file it was loaded from", async () => {
		const projectThemes = join(tempRoot, "project", ".pi", "themes");
		mkdirSync(projectThemes, { recursive: true });
		const themePath = join(projectThemes, "foo.json");
		writeTheme(themePath, "bar", 196);
		setRegisteredThemes([loadThemeFromPath(themePath, "256color")]);
		expect(setTheme("bar", true)).toEqual({ success: true });
		expect(theme.getFgAnsi("accent")).toBe("\x1b[38;5;196m");

		writeTheme(themePath, "bar", 46);

		await expect.poll(() => theme.getFgAnsi("accent"), { timeout: 3_000 }).toBe("\x1b[38;5;46m");
	});
});
