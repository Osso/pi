import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

class RecordingTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}
}

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
	it("enables focus reporting while running and disables it on stop", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);

		tui.start();
		tui.start();
		await terminal.waitForRender();
		tui.stop();
		tui.stop();

		const writes = terminal.getWrites();
		assert.equal(writes.split("\x1b[?1004h").length - 1, 1, "start should enable focus reporting once");
		assert.equal(writes.split("\x1b[?1004l").length - 1, 1, "stop should disable focus reporting once");
	});

	it("defers rendering while unfocused and renders the latest state on focus", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const focusedRenderCount = component.renderCount;

		terminal.sendInput(FOCUS_OUT);
		component.lines = ["stale", "state"];
		tui.requestRender();
		component.lines = ["latest", "state"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.equal(
			component.renderCount,
			focusedRenderCount,
			"unfocused updates should not traverse the component tree",
		);

		terminal.sendInput(FOCUS_IN);
		await terminal.waitForRender();

		assert.equal(component.renderCount, focusedRenderCount + 1, "focus-in should render pending state once");
		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 2), ["latest", "state"]);
		tui.stop();
	});

	it("cancels a queued forced render when focus is lost", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const focusedRenderCount = component.renderCount;

		const fullRedrawsBeforeForce = tui.fullRedraws;
		component.lines = ["forced while hidden"];
		tui.requestRender(true);
		terminal.sendInput(FOCUS_OUT);
		await terminal.waitForRender();

		assert.equal(component.renderCount, focusedRenderCount, "focus-out should cancel a queued forced render");
		assert.equal(tui.fullRedraws, fullRedrawsBeforeForce, "forced redraw should remain pending while unfocused");

		terminal.sendInput(FOCUS_IN);
		await terminal.waitForRender();
		assert.equal(component.renderCount, focusedRenderCount + 1);
		assert.equal(tui.fullRedraws, fullRedrawsBeforeForce + 1, "focus-in should preserve forced redraw semantics");
		tui.stop();
	});

	it("renders pending unfocused state after stop and restart", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const initialRenderCount = component.renderCount;

		terminal.sendInput(FOCUS_OUT);
		component.lines = ["updated while hidden"];
		tui.requestRender();
		tui.stop();
		tui.start();
		await terminal.waitForRender();

		assert.equal(component.renderCount, initialRenderCount + 1, "restart should render pending hidden state");
		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 1), ["updated while hidden"]);
		tui.stop();
	});

	it("renders state requested while stopped after restart", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TUI(terminal);
		const component = new MutableComponent();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const initialRenderCount = component.renderCount;

		tui.stop();
		component.lines = ["updated while stopped"];
		tui.requestRender();
		await new Promise<void>((resolve) => setImmediate(resolve));
		tui.start();
		await terminal.waitForRender();

		assert.equal(
			component.renderCount,
			initialRenderCount + 1,
			"restart should render state requested while stopped",
		);
		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 1), ["updated while stopped"]);
		tui.stop();
	});

	it("consumes focus events instead of forwarding them to the focused component", async () => {
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
		terminal.sendInput(FOCUS_IN);
		terminal.sendInput("x");

		assert.deepEqual(listenerInputs, ["x"]);
		assert.deepEqual(component.inputs, ["x"]);
		tui.stop();
	});
});
