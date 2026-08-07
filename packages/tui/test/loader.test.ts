import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Loader } from "../src/components/loader.ts";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createRenderCounter(): { tui: Pick<TUI, "requestComponentRender">; getRenderCount: () => number } {
	let renderCount = 0;
	const tui = {
		requestComponentRender(): boolean {
			renderCount++;
			return false;
		},
	};

	return { tui, getRenderCount: () => renderCount };
}

class RenderCountingComponent implements Component {
	renderCount = 0;

	render(_width: number): string[] {
		this.renderCount++;
		return ["unrelated"];
	}

	invalidate(): void {}
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

	it("falls back to a normal root render when no region is registered", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TUI(terminal);
		const loader = new Loader(
			tui,
			(value) => value,
			(value) => value,
			"Loading",
			{ frames: [] },
		);
		const unrelated = new RenderCountingComponent();
		tui.addChild(loader);
		tui.addChild(unrelated);
		tui.start();
		await terminal.waitForRender();
		const unrelatedRenderCount = unrelated.renderCount;

		loader.setMessage("Updated");
		await terminal.waitForRender();

		assert.strictEqual(unrelated.renderCount, unrelatedRenderCount + 1);
		assert.ok(terminal.getViewport().join("\n").includes("Updated"));
		loader.stop();
		tui.stop();
		await terminal.flush();
	});
});
