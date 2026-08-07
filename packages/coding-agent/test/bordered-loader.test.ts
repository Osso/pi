import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
}

describe("BorderedLoader", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders its status message without recurring spinner updates", () => {
		vi.useFakeTimers();
		initTheme("dark");
		const requestComponentRender = vi.fn(() => false);
		const loader = new BorderedLoader({ requestComponentRender } as unknown as TUI, createTheme(), "Working...");

		try {
			expect(stripAnsi(loader.render(80).join("\n"))).toContain("Working...");
			expect(requestComponentRender).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1_000);

			expect(requestComponentRender).toHaveBeenCalledTimes(1);
		} finally {
			loader.dispose();
		}
	});
});
