import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RootCompositor, type RootLayoutRect } from "../src/root-compositor.ts";
import { type Component, Container, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

describe("RootCompositor", () => {
	it("anchors the bottom zone while preserving flow component rendering", () => {
		const body = new TestComponent(["body"]);
		const status = new TestComponent(["status"]);
		const editor = new TestComponent(["editor top", "editor prompt", "editor bottom"]);
		const footer = new TestComponent(["footer"]);
		let editorRect: RootLayoutRect | undefined;
		const compositor = new RootCompositor({
			getHeight: () => 10,
			flow: [{ component: body }],
			bottom: [
				{ component: status },
				{
					component: editor,
					onLayout: (rect) => {
						editorRect = rect;
					},
				},
				{ component: footer },
			],
		});

		const lines = compositor.render(20);

		assert.deepStrictEqual(lines, [
			"body",
			"",
			"",
			"",
			"",
			"status",
			"editor top",
			"editor prompt",
			"editor bottom",
			"footer",
		]);
		assert.deepStrictEqual(editorRect, { row: 6, col: 0, width: 20, height: 3 });
	});

	it("recalculates bottom positions when footer height changes", () => {
		const editor = new TestComponent(["editor"]);
		const footer = new TestComponent(["footer"]);
		let editorRect: RootLayoutRect | undefined;
		const compositor = new RootCompositor({
			getHeight: () => 6,
			flow: [],
			bottom: [
				{
					component: editor,
					onLayout: (rect) => {
						editorRect = rect;
					},
				},
				{ component: footer },
			],
		});

		assert.deepStrictEqual(compositor.render(12), ["", "", "", "", "editor", "footer"]);
		assert.deepStrictEqual(editorRect, { row: 4, col: 0, width: 12, height: 1 });

		footer.lines = ["footer 1", "footer 2"];
		assert.deepStrictEqual(compositor.render(12), ["", "", "", "editor", "footer 1", "footer 2"]);
		assert.deepStrictEqual(editorRect, { row: 3, col: 0, width: 12, height: 1 });
	});

	it("restores bottom anchoring after a tall editor replacement closes with Escape", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const body = new TestComponent(["body 1", "body 2", "body 3", "body 4", "body 5"]);
		const editor = new TestComponent([`editor${CURSOR_MARKER}`]);
		const editorContainer = new Container();
		const footer = new TestComponent(["footer"]);
		editorContainer.addChild(editor);
		const selector: Component = {
			render: () =>
				Array.from({ length: 5 }, (_, index) =>
					index === 1 ? `selector ${index + 1}${CURSOR_MARKER}` : `selector ${index + 1}`,
				),
			invalidate: () => {},
			handleInput: (data) => {
				if (data !== "\x1b") return;
				editorContainer.clear();
				editorContainer.addChild(editor);
				tui.setFocus(editor);
				tui.requestRender();
			},
		};
		const compositor = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: body }],
			bottom: [{ component: editorContainer }, { component: footer }],
		});
		tui.addChild(compositor);
		tui.start();
		await terminal.waitForRender();
		editorContainer.clear();
		editorContainer.addChild(selector);
		tui.setFocus(selector);
		tui.requestRender();
		await terminal.waitForRender();

		terminal.sendInput("\x1b");
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["body 2", "body 3", "body 4", "body 5", "editor", "footer"]);
		tui.stop();
		await terminal.flush();
	});

	it("keeps the full flow when content exceeds the viewport", () => {
		const body = new TestComponent(["body 1", "body 2", "body 3", "body 4"]);
		const editor = new TestComponent(["editor"]);
		const footer = new TestComponent(["footer"]);
		let editorRect: RootLayoutRect | undefined;
		const compositor = new RootCompositor({
			getHeight: () => 4,
			flow: [{ component: body }],
			bottom: [
				{
					component: editor,
					onLayout: (rect) => {
						editorRect = rect;
					},
				},
				{ component: footer },
			],
		});

		assert.deepStrictEqual(compositor.render(10), ["body 1", "body 2", "body 3", "body 4", "editor", "footer"]);
		assert.deepStrictEqual(editorRect, { row: 4, col: 0, width: 10, height: 1 });
	});
});
