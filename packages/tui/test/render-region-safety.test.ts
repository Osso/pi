import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RootCompositor } from "../src/root-compositor.ts";
import { type Component, Container, CURSOR_MARKER, type RenderRegion, type RenderRegionRect, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const KITTY_IMAGE_LINE = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";

class MutableComponent implements Component {
	lines: string[];
	renderCount = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		this.renderCount++;
		return this.lines;
	}

	invalidate(): void {}
}

type SafetyFixture = {
	terminal: VirtualTerminal;
	tui: TUI;
	region: RenderRegion;
	descendant: MutableComponent;
	unrelated: MutableComponent;
};

async function startFixture(initialLines: string[] = ["region one", "region two"]): Promise<SafetyFixture> {
	const terminal = new VirtualTerminal(24, 8);
	const tui = new TUI(terminal);
	const regionRoot = new Container();
	const descendant = new MutableComponent(initialLines);
	const unrelated = new MutableComponent(["unrelated"]);
	regionRoot.addChild(descendant);
	const region = tui.createRenderRegion(regionRoot);
	const root = new RootCompositor({
		getHeight: () => terminal.rows,
		flow: [{ component: regionRoot, onLayout: region.place }, { component: unrelated }],
		bottom: [],
	});
	tui.addChild(root);
	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, region, descendant, unrelated };
}

async function stopFixture(fixture: SafetyFixture): Promise<void> {
	fixture.tui.stop();
	await fixture.terminal.flush();
}

async function expectNormalRenderFallback(fixture: SafetyFixture): Promise<void> {
	const unrelatedRenderCount = fixture.unrelated.renderCount;
	assert.strictEqual(fixture.tui.requestComponentRender(fixture.descendant), false);
	await fixture.terminal.waitForRender();
	assert.ok(fixture.unrelated.renderCount > unrelatedRenderCount);
}

const invalidPlacements: Array<{ name: string; rect: RenderRegionRect }> = [
	{ name: "non-full-width placement", rect: { row: 0, col: 1, width: 23, height: 2 } },
	{ name: "negative row", rect: { row: -1, col: 0, width: 24, height: 2 } },
	{ name: "frame overrun", rect: { row: 0, col: 0, width: 24, height: 9 } },
];

const unsafeLines: Array<{ name: string; lines: string[] }> = [
	{ name: "cursor marker", lines: [`cursor ${CURSOR_MARKER}`, "second"] },
	{ name: "Kitty image output", lines: [KITTY_IMAGE_LINE, "second"] },
];

describe("TUI render region safety fallbacks", () => {
	for (const { name, rect } of invalidPlacements) {
		it(`uses a normal root render for ${name}`, async () => {
			const fixture = await startFixture();
			try {
				fixture.region.place(rect);
				fixture.descendant.lines = ["changed one", "changed two"];
				await expectNormalRenderFallback(fixture);
			} finally {
				await stopFixture(fixture);
			}
		});
	}

	for (const { name, lines } of unsafeLines) {
		it(`uses a normal root render for ${name}`, async () => {
			const fixture = await startFixture();
			try {
				fixture.descendant.lines = lines;
				await expectNormalRenderFallback(fixture);
			} finally {
				await stopFixture(fixture);
			}
		});
	}

	it("rejects over-width partial output before a normal render recovers", async () => {
		const fixture = await startFixture();
		try {
			const unrelatedRenderCount = fixture.unrelated.renderCount;
			fixture.descendant.lines = ["x".repeat(25), "second"];

			assert.strictEqual(fixture.tui.requestComponentRender(fixture.descendant), false);
			fixture.descendant.lines = ["recovered", "second"];
			await fixture.terminal.waitForRender();

			assert.ok(fixture.unrelated.renderCount > unrelatedRenderCount);
			assert.strictEqual(fixture.terminal.getViewport()[0], "recovered");
		} finally {
			await stopFixture(fixture);
		}
	});

	it("uses a normal root render when cached region lines contain a Kitty image", async () => {
		const fixture = await startFixture([KITTY_IMAGE_LINE, "second"]);
		try {
			fixture.descendant.lines = ["image removed", "second"];
			await expectNormalRenderFallback(fixture);
		} finally {
			await stopFixture(fixture);
		}
	});
});
