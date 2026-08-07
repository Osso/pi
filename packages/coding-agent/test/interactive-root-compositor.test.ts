import assert from "node:assert/strict";
import { type Component, Container, Loader, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createInteractiveRootCompositor } from "../src/modes/interactive/interactive-root-compositor.ts";

class TestComponent implements Component {
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

describe("interactive root compositor", () => {
	it("preserves flow and bottom component order while reporting editor bounds", () => {
		let terminalHeight = 12;
		const components = {
			header: new TestComponent(["header"]),
			loadedResources: new TestComponent(["resources"]),
			chat: new TestComponent(["chat"]),
			pendingMessages: new TestComponent(["pending"]),
			status: new TestComponent(["status"]),
			widgetAbove: new TestComponent(["above"]),
			editor: new TestComponent(["editor top", "editor prompt", "editor bottom"]),
			widgetBelow: new TestComponent(["below"]),
			footer: new TestComponent(["footer"]),
		};
		let editorOrigin: { row: number; col: number } | undefined;
		const compositor = createInteractiveRootCompositor({
			getHeight: () => terminalHeight,
			...components,
			onStatusLayout: () => {},
			onEditorLayout: ({ row, col }) => {
				editorOrigin = { row, col };
			},
		});

		assert.deepStrictEqual(compositor.render(20), [
			"header",
			"resources",
			"chat",
			"pending",
			"",
			"status",
			"above",
			"editor top",
			"editor prompt",
			"editor bottom",
			"below",
			"footer",
		]);
		assert.deepStrictEqual(editorOrigin, { row: 7, col: 0 });

		terminalHeight = 14;
		compositor.render(20);
		assert.deepStrictEqual(editorOrigin, { row: 9, col: 0 });

		components.footer.lines = ["footer 1", "footer 2"];
		compositor.render(20);
		assert.deepStrictEqual(editorOrigin, { row: 8, col: 0 });

		components.editor.lines = ["editor top", "editor prompt", "editor middle", "editor bottom"];
		compositor.render(20);
		assert.deepStrictEqual(editorOrigin, { row: 7, col: 0 });
	});

	it("renders status loader updates without rendering unrelated root entries", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const status = new Container();
		const loader = new Loader(
			tui,
			(value) => value,
			(value) => value,
			"Thinking...",
			{ frames: [] },
		);
		status.addChild(loader);
		const statusRegion = tui.createRenderRegion(status);
		const components = {
			header: new TestComponent(["header"]),
			loadedResources: new TestComponent([]),
			chat: new TestComponent(["chat"]),
			pendingMessages: new TestComponent([]),
			status,
			widgetAbove: new TestComponent([]),
			editor: new TestComponent(["editor"]),
			widgetBelow: new TestComponent([]),
			footer: new TestComponent(["footer"]),
		};
		const compositor = createInteractiveRootCompositor({
			getHeight: () => terminal.rows,
			...components,
			onStatusLayout: statusRegion.place,
			onEditorLayout: () => {},
		});
		tui.addChild(compositor);
		tui.start();
		await terminal.waitForRender();
		const unrelatedCounts = {
			header: components.header.renderCount,
			chat: components.chat.renderCount,
			editor: components.editor.renderCount,
			footer: components.footer.renderCount,
		};

		loader.setMessage("Thinking... 1s");
		await terminal.waitForRender();

		expect(terminal.getViewport().join("\n")).toContain("Thinking... 1s");
		expect(components.header.renderCount).toBe(unrelatedCounts.header);
		expect(components.chat.renderCount).toBe(unrelatedCounts.chat);
		expect(components.editor.renderCount).toBe(unrelatedCounts.editor);
		expect(components.footer.renderCount).toBe(unrelatedCounts.footer);
		loader.stop();
		tui.stop();
		await terminal.flush();
	});
});
