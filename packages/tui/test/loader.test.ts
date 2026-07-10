import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

function createRenderCounter(): { tui: TUI; getRenderCount: () => number } {
	let renderCount = 0;
	const tui = {
		requestRender(): void {
			renderCount++;
		},
	} as TUI;

	return { tui, getRenderCount: () => renderCount };
}

describe("Loader", () => {
	it("advances the default spinner no more than four times per second", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const { tui, getRenderCount } = createRenderCounter();
		const loader = new Loader(
			tui,
			(value) => value,
			(value) => value,
		);

		try {
			assert.equal(getRenderCount(), 1, "construction renders the initial frame");

			mock.timers.tick(249);
			assert.equal(getRenderCount(), 1, "default spinner should not advance before 250 ms");

			mock.timers.tick(1);
			assert.equal(getRenderCount(), 2, "default spinner should advance at 250 ms");
		} finally {
			loader.stop();
			mock.timers.reset();
		}
	});
});
