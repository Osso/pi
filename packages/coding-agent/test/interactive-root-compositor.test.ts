import assert from "node:assert/strict";
import { type Component, Container, Loader, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	createInteractiveRootCompositor,
	type InteractiveRootFlowLayout,
} from "../src/modes/interactive/interactive-root-compositor.ts";

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
			transcriptTail: new TestComponent(["tail"]),
			pendingMessages: new TestComponent(["pending"]),
			status: new TestComponent(["status"]),
			widgetAbove: new TestComponent(["above"]),
			editor: new TestComponent(["editor top", "editor prompt", "editor bottom"]),
			widgetBelow: new TestComponent(["below"]),
			footer: new TestComponent(["footer"]),
		};
		let editorOrigin: { row: number; col: number } | undefined;
		let transcriptTailLayout: InteractiveRootFlowLayout | undefined;
		const compositor = createInteractiveRootCompositor({
			getHeight: () => terminalHeight,
			...components,
			onChatLayout: () => {},
			onTranscriptTailLayout: (layout) => {
				transcriptTailLayout = layout;
			},
			onStatusLayout: () => {},
			onEditorLayout: ({ row, col }) => {
				editorOrigin = { row, col };
			},
		});

		assert.deepStrictEqual(compositor.render(20), [
			"header",
			"resources",
			"chat",
			"tail",
			"pending",
			"status",
			"above",
			"editor top",
			"editor prompt",
			"editor bottom",
			"below",
			"footer",
		]);
		assert.deepStrictEqual(editorOrigin, { row: 7, col: 0 });
		assert.deepStrictEqual(transcriptTailLayout, {
			rect: { row: 3, col: 0, width: 20, height: 1 },
			flowEndRow: 5,
			bottomRow: 5,
			bottomHeight: 7,
			viewportHeight: 12,
		});

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
			transcriptTail: new TestComponent([]),
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
			onChatLayout: () => {},
			onTranscriptTailLayout: () => {},
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

	it("renders transcript tail growth through production partial-region wiring", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const transcriptTail = new TestComponent(["tail one"]);
		const transcriptTailRegion = tui.createFlowRenderRegion(transcriptTail);
		const components = {
			header: new TestComponent(["header"]),
			loadedResources: new TestComponent([]),
			chat: new TestComponent(["chat"]),
			transcriptTail,
			pendingMessages: new TestComponent(["pending"]),
			status: new TestComponent(["status"]),
			widgetAbove: new TestComponent([]),
			editor: new TestComponent(["editor"]),
			widgetBelow: new TestComponent([]),
			footer: new TestComponent(["footer"]),
		};
		const compositor = createInteractiveRootCompositor({
			getHeight: () => terminal.rows,
			...components,
			onChatLayout: () => {},
			onTranscriptTailLayout: transcriptTailRegion.place,
			onStatusLayout: () => {},
			onEditorLayout: () => {},
		});
		tui.addChild(compositor);
		tui.start();
		try {
			await terminal.waitForRender();
			const initialRenderCounts = {
				header: components.header.renderCount,
				loadedResources: components.loadedResources.renderCount,
				chat: components.chat.renderCount,
				pendingMessages: components.pendingMessages.renderCount,
				status: components.status.renderCount,
				widgetAbove: components.widgetAbove.renderCount,
				editor: components.editor.renderCount,
				widgetBelow: components.widgetBelow.renderCount,
				footer: components.footer.renderCount,
				transcriptTail: components.transcriptTail.renderCount,
			};

			components.transcriptTail.lines = ["tail one", "tail two", "tail three"];
			assert.strictEqual(tui.requestComponentRender(components.transcriptTail), true);
			await terminal.waitForRender();

			assert.deepStrictEqual(terminal.getViewport(), [
				"header",
				"chat",
				"tail one",
				"tail two",
				"tail three",
				"pending",
				"",
				"status",
				"editor",
				"footer",
			]);
			assert.strictEqual(components.transcriptTail.renderCount, initialRenderCounts.transcriptTail + 1);
			assert.strictEqual(components.header.renderCount, initialRenderCounts.header);
			assert.strictEqual(components.loadedResources.renderCount, initialRenderCounts.loadedResources);
			assert.strictEqual(components.chat.renderCount, initialRenderCounts.chat);
			assert.strictEqual(components.pendingMessages.renderCount, initialRenderCounts.pendingMessages);
			assert.strictEqual(components.status.renderCount, initialRenderCounts.status);
			assert.strictEqual(components.widgetAbove.renderCount, initialRenderCounts.widgetAbove);
			assert.strictEqual(components.editor.renderCount, initialRenderCounts.editor);
			assert.strictEqual(components.widgetBelow.renderCount, initialRenderCounts.widgetBelow);
			assert.strictEqual(components.footer.renderCount, initialRenderCounts.footer);
		} finally {
			tui.stop();
			await terminal.flush();
		}
	});
});
