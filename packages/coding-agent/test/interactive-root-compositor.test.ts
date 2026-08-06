import assert from "node:assert/strict";
import type { Component } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { createInteractiveRootCompositor } from "../src/modes/interactive/interactive-root-compositor.ts";

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
	});
});
