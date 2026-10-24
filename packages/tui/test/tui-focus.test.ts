import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

class MutableComponent implements Component {
	lines = ["initial"];
	renderCount = 0;
	inputs: string[] = [];

	render(_width: number): string[] {
		this.renderCount++;
		return this.lines;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI terminal focus", () => {
	it("coalesces updates after focus-out without waiting for focus-in", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const initialRenderCount = component.renderCount;

		terminal.sendInput(FOCUS_OUT);
		component.lines = ["stale", "state"];
		tui.requestRender();
		component.lines = ["latest", "state"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.equal(component.renderCount, initialRenderCount + 1, "updates should coalesce into one render");
		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 2), ["latest", "state"]);

		terminal.sendInput(FOCUS_IN);
		await terminal.waitForRender();
		assert.equal(component.renderCount, initialRenderCount + 1, "focus-in alone should not request a render");
		tui.stop();
	});

	it("preserves a queued forced render when focus is lost", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const initialRenderCount = component.renderCount;
		const fullRedrawsBeforeForce = tui.fullRedraws;

		component.lines = ["forced after blur"];
		tui.requestRender(true);
		terminal.sendInput(FOCUS_OUT);
		await terminal.waitForRender();

		assert.equal(component.renderCount, initialRenderCount + 1);
		assert.equal(tui.fullRedraws, fullRedrawsBeforeForce + 1, "focus-out should not cancel forced redraws");
		assert.equal((await terminal.flushAndGetViewport())[0], "forced after blur");
		tui.stop();
	});

	it("paints resize updates after focus-out", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput(FOCUS_OUT);
		component.lines = ["question", "answer"];
		terminal.resize(60, 12);
		await terminal.waitForRender();

		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 2), ["question", "answer"]);
		tui.stop();
	});

	it("writes fixed cells and render regions after focus-out", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		const cell = tui.createFixedCell();
		const region = tui.createRenderRegion(component);
		tui.start();
		await terminal.waitForRender();
		cell.place(0, 0);
		region.place({ row: 0, col: 0, width: terminal.columns, height: 1 });

		terminal.sendInput(FOCUS_OUT);
		assert.equal(cell.update("X"), true);
		assert.equal((await terminal.flushAndGetViewport())[0], "Xnitial");
		component.lines = ["updated region"];
		assert.equal(region.tryRender(), true);
		assert.equal((await terminal.flushAndGetViewport())[0], "Xpdated region");
		tui.stop();
		assert.equal(cell.update("Y"), false, "stopped fixed cells should not paint");
		assert.equal(region.tryRender(), false, "stopped render regions should not paint");
	});

	it("renders state requested while stopped only after restart", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const initialRenderCount = component.renderCount;

		terminal.sendInput(FOCUS_OUT);
		tui.stop();
		component.lines = ["updated while stopped"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.equal(component.renderCount, initialRenderCount, "stopped TUI should not render");
		tui.start();
		await terminal.waitForRender();

		assert.equal(component.renderCount, initialRenderCount + 1);
		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 1), ["updated while stopped"]);
		tui.stop();
	});

	it("consumes focus events before listeners without changing component focus", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await terminal.waitForRender();

		const listenerInputs: string[] = [];
		tui.addInputListener((data) => {
			listenerInputs.push(data);
			return undefined;
		});

		terminal.sendInput(FOCUS_OUT);
		assert.equal(tui.getFocusedComponent(), component);
		terminal.sendInput("x");
		terminal.sendInput(FOCUS_IN);
		assert.equal(tui.getFocusedComponent(), component);
		terminal.sendInput("y");

		assert.deepEqual(listenerInputs, ["x", "y"]);
		assert.deepEqual(component.inputs, ["x", "y"]);
		tui.stop();
	});
});
