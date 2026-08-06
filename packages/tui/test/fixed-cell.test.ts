import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component } from "../src/tui.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RenderCountingComponent implements Component {
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

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	clearWrites(): void {
		this.writes = [];
	}

	getWrites(): string {
		return this.writes.join("");
	}
}

describe("TUI fixed-cell updates", () => {
	it("updates one visible cell without rendering the component tree", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new RenderCountingComponent(["body", "› prompt", "footer"]);
		const cell = tui.createFixedCell();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();
		const renderCount = component.renderCount;

		cell.place(1, 0);
		const updated = cell.update("⠋");
		await terminal.flush();

		assert.strictEqual(updated, true);
		assert.strictEqual(component.renderCount, renderCount);
		assert.strictEqual(terminal.getViewport()[1], "⠋ prompt");
		assert.ok(terminal.getWrites().length > 0);
		tui.stop();
	});

	it("synchronizes the previous frame so the next normal render performs no corrective write", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new RenderCountingComponent(["body", "› prompt", "footer"]);
		const cell = tui.createFixedCell();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		component.lines = ["body", "⠋ prompt", "footer"];
		cell.place(1, 0);
		assert.strictEqual(cell.update("⠋"), true);
		await terminal.flush();
		terminal.clearWrites();

		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(terminal.getWrites(), "");
		assert.strictEqual(terminal.getViewport()[1], "⠋ prompt");
		tui.stop();
	});

	it("rejects fixed-cell writes while a normal render is pending", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new RenderCountingComponent(["body", "› prompt", "footer"]);
		const cell = tui.createFixedCell();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["body", "queued prompt", "footer"];
		const renderCountBeforePendingRender = component.renderCount;
		tui.requestRender();
		cell.place(1, 0);

		assert.strictEqual(cell.update("⠋"), false);
		assert.strictEqual(terminal.getWrites(), "");
		assert.strictEqual(terminal.getViewport()[1], "› prompt");

		await terminal.waitForRender();

		assert.strictEqual(component.renderCount, renderCountBeforePendingRender + 1);
		assert.strictEqual(terminal.getViewport()[1], "⠋ueued prompt");
		tui.stop();
	});

	it("rejects fixed-cell writes before resize render and accepts them after repositioning", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new RenderCountingComponent(["body", "› prompt", "footer"]);
		const cell = tui.createFixedCell();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		cell.place(1, 0);
		terminal.resize(30, 6);

		assert.strictEqual(cell.update("⠋"), false);
		assert.strictEqual(terminal.getWrites(), "");

		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[1], "⠋ prompt");
		const renderCountAfterResize = component.renderCount;
		terminal.clearWrites();

		cell.place(2, 0);
		assert.strictEqual(cell.update("X"), true);
		await terminal.flush();

		assert.strictEqual(component.renderCount, renderCountAfterResize);
		assert.strictEqual(terminal.getViewport()[2], "Xooter");
		assert.ok(terminal.getWrites().length > 0);
		tui.stop();
	});

	it("rejects fixed-cell writes while an overlay is visible", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new RenderCountingComponent(["body", "› prompt", "footer"]);
		const overlay = new RenderCountingComponent(["overlay"]);
		const cell = tui.createFixedCell();
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		const overlayHandle = tui.showOverlay(overlay, { row: 1, col: 0, width: 7 });
		await terminal.waitForRender();
		terminal.clearWrites();

		cell.place(1, 0);
		assert.strictEqual(cell.update("⠋"), false);
		await terminal.flush();
		assert.strictEqual(terminal.getWrites(), "");
		assert.ok(terminal.getViewport()[1]?.startsWith("overlay"));
		assert.ok(!terminal.getViewport()[1]?.includes("⠋"));

		overlayHandle.hide();
		await terminal.waitForRender();
		tui.stop();
	});
});
