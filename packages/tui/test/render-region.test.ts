import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RootCompositor } from "../src/root-compositor.ts";
import { type Component, Container, CURSOR_MARKER, type RenderRegion, TUI } from "../src/tui.ts";
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

type RenderRegionFixture = {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	regionRoot: Container;
	region: RenderRegion;
	descendant: RenderCountingComponent;
	unrelated: RenderCountingComponent;
};

function createFixture(): RenderRegionFixture {
	const terminal = new LoggingVirtualTerminal(24, 8);
	const tui = new TUI(terminal);
	const regionRoot = new Container();
	const descendant = new RenderCountingComponent(["region one", "region two"]);
	const unrelated = new RenderCountingComponent(["unrelated row"]);
	regionRoot.addChild(descendant);

	const region = tui.createRenderRegion(regionRoot);
	const root = new RootCompositor({
		getHeight: () => terminal.rows,
		flow: [{ component: regionRoot, onLayout: region.place }, { component: unrelated }],
		bottom: [],
	});
	tui.addChild(root);
	tui.start();

	return { terminal, tui, regionRoot, region, descendant, unrelated };
}

async function startFixture(): Promise<RenderRegionFixture> {
	const fixture = createFixture();
	await fixture.terminal.waitForRender();
	fixture.terminal.clearWrites();
	return fixture;
}

async function stopFixture(fixture: RenderRegionFixture): Promise<void> {
	fixture.tui.stop();
	await fixture.terminal.flush();
}

describe("TUI full-width render regions", () => {
	it("renders a same-height descendant update only inside its registered region", async () => {
		const fixture = await startFixture();
		try {
			const unrelatedRenderCount = fixture.unrelated.renderCount;
			fixture.descendant.lines = ["region changed", "second changed"];

			assert.strictEqual(fixture.tui.requestComponentRender(fixture.descendant), true);
			await fixture.terminal.waitForRender();

			assert.deepStrictEqual(fixture.terminal.getViewport().slice(0, 3), [
				"region changed",
				"second changed",
				"unrelated row",
			]);
			assert.strictEqual(fixture.unrelated.renderCount, unrelatedRenderCount);
			assert.ok(fixture.terminal.getWrites().length > 0);
		} finally {
			await stopFixture(fixture);
		}
	});

	it("grows a flow tail without rendering surrounding components", async () => {
		const terminal = new LoggingVirtualTerminal(24, 8);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history"]);
		const tailRoot = new Container();
		const tail = new RenderCountingComponent(["tail one"]);
		const followingFlow = new RenderCountingComponent(["following"]);
		const editor = new RenderCountingComponent(["editor"]);
		const footer = new RenderCountingComponent(["footer"]);
		tailRoot.addChild(tail);
		const region = tui.createFlowRenderRegion(tailRoot);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [
				{ component: history },
				{ component: tailRoot, onFlowLayout: region.place },
				{ component: followingFlow },
			],
			bottom: [{ component: editor }, { component: footer }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();
		const historyRenderCount = history.renderCount;
		const followingRenderCount = followingFlow.renderCount;
		const editorRenderCount = editor.renderCount;
		const footerRenderCount = footer.renderCount;
		tail.lines = ["tail one", "tail two", "tail three"];

		assert.strictEqual(tui.requestComponentRender(tail), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), [
			"history",
			"tail one",
			"tail two",
			"tail three",
			"following",
			"",
			"editor",
			"footer",
		]);
		assert.strictEqual(history.renderCount, historyRenderCount);
		assert.strictEqual(followingFlow.renderCount, followingRenderCount);
		assert.strictEqual(editor.renderCount, editorRenderCount);
		assert.strictEqual(footer.renderCount, footerRenderCount);
		assert.ok(terminal.getWrites().length > 0);
		tui.stop();
		await terminal.flush();
	});

	it("appends and routes a new descendant from an empty flow tail", async () => {
		const terminal = new LoggingVirtualTerminal(24, 6);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history"]);
		const tailRoot = new Container();
		const pending = new RenderCountingComponent(["pending"]);
		const editor = new RenderCountingComponent(["editor"]);
		const footer = new RenderCountingComponent(["footer"]);
		const region = tui.createFlowRenderRegion(tailRoot);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: history }, { component: tailRoot, onFlowLayout: region.place }, { component: pending }],
			bottom: [{ component: editor }, { component: footer }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		const unchangedRenderCounts = {
			history: history.renderCount,
			pending: pending.renderCount,
			editor: editor.renderCount,
			footer: footer.renderCount,
		};
		const message = new RenderCountingComponent(["new message"]);
		tailRoot.addChild(message);

		assert.strictEqual(region.requestRender(), true);
		await terminal.waitForRender();
		message.lines = ["updated message"];
		assert.strictEqual(tui.requestComponentRender(message), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["history", "updated message", "pending", "", "editor", "footer"]);
		assert.strictEqual(history.renderCount, unchangedRenderCounts.history);
		assert.strictEqual(pending.renderCount, unchangedRenderCounts.pending);
		assert.strictEqual(editor.renderCount, unchangedRenderCounts.editor);
		assert.strictEqual(footer.renderCount, unchangedRenderCounts.footer);
		tui.stop();
		await terminal.flush();
	});

	it("updates the visible rows of a flow tail that starts above the viewport", async () => {
		const terminal = new LoggingVirtualTerminal(24, 4);
		const tui = new TUI(terminal);
		const tail = new RenderCountingComponent(["tail one", "tail two", "tail three", "tail four", "tail five"]);
		const editor = new RenderCountingComponent(["editor"]);
		const region = tui.createFlowRenderRegion(tail);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: tail, onFlowLayout: region.place }],
			bottom: [{ component: editor }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		const editorRenderCount = editor.renderCount;
		tail.lines = ["tail one", "tail two", "tail three", "tail four", "tail changed"];

		assert.strictEqual(tui.requestComponentRender(tail), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["tail three", "tail four", "tail changed", "editor"]);
		assert.strictEqual(editor.renderCount, editorRenderCount);
		tui.stop();
		await terminal.flush();
	});

	it("grows a visible flow tail while preserving terminal scrollback", async () => {
		const terminal = new LoggingVirtualTerminal(24, 4);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history one", "history two", "history three"]);
		const tail = new RenderCountingComponent(["tail one"]);
		const editor = new RenderCountingComponent(["editor"]);
		const region = tui.createFlowRenderRegion(tail);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: history }, { component: tail, onFlowLayout: region.place }],
			bottom: [{ component: editor }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		const historyRenderCount = history.renderCount;
		const editorRenderCount = editor.renderCount;
		tail.lines = ["tail one", "tail two"];

		assert.strictEqual(tui.requestComponentRender(tail), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["history three", "tail one", "tail two", "editor"]);
		assert.deepStrictEqual(terminal.getScrollBuffer().slice(-6), [
			"history one",
			"history two",
			"history three",
			"tail one",
			"tail two",
			"editor",
		]);
		assert.strictEqual(history.renderCount, historyRenderCount);
		assert.strictEqual(editor.renderCount, editorRenderCount);
		tui.stop();
		await terminal.flush();
	});

	it("preserves a bottom hardware cursor while a flow tail grows", async () => {
		const terminal = new LoggingVirtualTerminal(24, 4);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history one", "history two", "history three"]);
		const tail = new RenderCountingComponent(["tail one"]);
		const editor = new RenderCountingComponent([`editor ${CURSOR_MARKER}`]);
		const region = tui.createFlowRenderRegion(tail);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: history }, { component: tail, onFlowLayout: region.place }],
			bottom: [{ component: editor }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		const editorRenderCount = editor.renderCount;
		tail.lines = ["tail one", "tail two"];

		assert.strictEqual(tui.requestComponentRender(tail), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["history three", "tail one", "tail two", "editor "]);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 7, y: 3 });
		assert.strictEqual(editor.renderCount, editorRenderCount);
		tui.stop();
		await terminal.flush();
	});

	it("shifts a fixed bottom cell after flow-tail growth", async () => {
		const terminal = new LoggingVirtualTerminal(24, 4);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history one", "history two", "history three"]);
		const tail = new RenderCountingComponent(["tail one"]);
		const editor = new RenderCountingComponent(["editor"]);
		const tailRegion = tui.createFlowRenderRegion(tail);
		const fixedCell = tui.createFixedCell();
		fixedCell.update("*");
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: history }, { component: tail, onFlowLayout: tailRegion.place }],
			bottom: [
				{
					component: editor,
					onLayout: (rect) => fixedCell.place(rect.row, 0),
				},
			],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		tail.lines = ["tail one", "tail two"];
		assert.strictEqual(tui.requestComponentRender(tail), true);
		await terminal.waitForRender();

		assert.strictEqual(fixedCell.update("#"), true);
		await terminal.flush();

		assert.deepStrictEqual(terminal.getViewport(), ["history three", "tail one", "tail two", "#ditor"]);
		tui.stop();
		await terminal.flush();
	});

	it("shifts a registered bottom region after flow-tail growth", async () => {
		const terminal = new LoggingVirtualTerminal(24, 4);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history one", "history two", "history three"]);
		const tail = new RenderCountingComponent(["tail one"]);
		const status = new RenderCountingComponent(["status"]);
		const tailRegion = tui.createFlowRenderRegion(tail);
		const statusRegion = tui.createRenderRegion(status);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: history }, { component: tail, onFlowLayout: tailRegion.place }],
			bottom: [{ component: status, onLayout: statusRegion.place }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		tail.lines = ["tail one", "tail two"];
		assert.strictEqual(tui.requestComponentRender(tail), true);
		await terminal.waitForRender();
		status.lines = ["status changed"];

		assert.strictEqual(tui.requestComponentRender(status), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(terminal.getViewport(), ["history three", "tail one", "tail two", "status changed"]);
		tui.stop();
		await terminal.flush();
	});

	it("synchronizes the previous frame after a partial region update", async () => {
		const fixture = await startFixture();
		try {
			fixture.descendant.lines = ["cached region", "cached second"];
			assert.strictEqual(fixture.tui.requestComponentRender(fixture.descendant), true);
			await fixture.terminal.waitForRender();
			fixture.terminal.clearWrites();

			fixture.tui.requestRender();
			await fixture.terminal.waitForRender();

			assert.strictEqual(fixture.terminal.getWrites(), "");
			assert.deepStrictEqual(fixture.terminal.getViewport().slice(0, 3), [
				"cached region",
				"cached second",
				"unrelated row",
			]);
		} finally {
			await stopFixture(fixture);
		}
	});

	it("does not mutate component-owned cached line arrays", async () => {
		const terminal = new LoggingVirtualTerminal(24, 8);
		const tui = new TUI(terminal);
		const component = new RenderCountingComponent(["initial one", "initial two"]);
		const region = tui.createRenderRegion(component);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component, onLayout: region.place }],
			bottom: [],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		component.lines = ["owned region", "owned second"];
		const ownedLines = component.lines;

		assert.strictEqual(tui.requestComponentRender(component), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(ownedLines, ["owned region", "owned second"]);
		tui.stop();
		await terminal.flush();
	});

	it("refreshes descendant routing after a same-height subtree replacement", async () => {
		const fixture = await startFixture();
		try {
			const replacement = new RenderCountingComponent(["replacement one", "replacement two"]);
			fixture.regionRoot.clear();
			fixture.regionRoot.addChild(replacement);

			assert.strictEqual(fixture.region.requestRender(), true);
			await fixture.terminal.waitForRender();
			const unrelatedRenderCount = fixture.unrelated.renderCount;
			replacement.lines = ["replacement changed", "replacement second"];

			assert.strictEqual(fixture.tui.requestComponentRender(replacement), true);
			await fixture.terminal.waitForRender();

			assert.strictEqual(fixture.unrelated.renderCount, unrelatedRenderCount);
			assert.strictEqual(fixture.terminal.getViewport()[0], "replacement changed");
		} finally {
			await stopFixture(fixture);
		}
	});

	it("falls back to a normal root render when a flow tail shrinks", async () => {
		const terminal = new LoggingVirtualTerminal(24, 6);
		const tui = new TUI(terminal);
		const history = new RenderCountingComponent(["history"]);
		const tail = new RenderCountingComponent(["tail one", "tail two"]);
		const pending = new RenderCountingComponent(["pending"]);
		const editor = new RenderCountingComponent(["editor"]);
		const region = tui.createFlowRenderRegion(tail);
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [{ component: history }, { component: tail, onFlowLayout: region.place }, { component: pending }],
			bottom: [{ component: editor }],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();
		const historyRenderCount = history.renderCount;
		const pendingRenderCount = pending.renderCount;
		const editorRenderCount = editor.renderCount;
		tail.lines = ["tail one"];

		assert.strictEqual(tui.requestComponentRender(tail), false);
		await terminal.waitForRender();

		assert.ok(history.renderCount > historyRenderCount);
		assert.ok(pending.renderCount > pendingRenderCount);
		assert.ok(editor.renderCount > editorRenderCount);
		assert.deepStrictEqual(terminal.getViewport(), ["history", "tail one", "pending", "", "", "editor"]);
		tui.stop();
		await terminal.flush();
	});

	it("falls back to a normal root render when the region height changes", async () => {
		const fixture = await startFixture();
		try {
			const descendantRenderCount = fixture.descendant.renderCount;
			const unrelatedRenderCount = fixture.unrelated.renderCount;
			fixture.descendant.lines = ["expanded one", "expanded two", "expanded three"];

			assert.strictEqual(fixture.tui.requestComponentRender(fixture.descendant), false);
			await fixture.terminal.waitForRender();

			assert.ok(fixture.descendant.renderCount > descendantRenderCount);
			assert.ok(fixture.unrelated.renderCount > unrelatedRenderCount);
			assert.deepStrictEqual(fixture.terminal.getViewport().slice(0, 4), [
				"expanded one",
				"expanded two",
				"expanded three",
				"unrelated row",
			]);
		} finally {
			await stopFixture(fixture);
		}
	});

	it("uses normal rendering when a render, resize, or visible overlay makes placement unsafe", async () => {
		const pending = await startFixture();
		try {
			const pendingDescendantCount = pending.descendant.renderCount;
			const pendingUnrelatedCount = pending.unrelated.renderCount;
			pending.descendant.lines = ["pending region", "pending second"];
			pending.tui.requestRender();
			assert.strictEqual(pending.tui.requestComponentRender(pending.descendant), false);
			await pending.terminal.waitForRender();

			assert.strictEqual(pending.descendant.renderCount, pendingDescendantCount + 1);
			assert.strictEqual(pending.unrelated.renderCount, pendingUnrelatedCount + 1);
			assert.strictEqual(pending.terminal.getViewport()[0], "pending region");
		} finally {
			await stopFixture(pending);
		}

		const resized = await startFixture();
		try {
			const resizedDescendantCount = resized.descendant.renderCount;
			const resizedUnrelatedCount = resized.unrelated.renderCount;
			resized.descendant.lines = ["resized region", "resized second"];
			resized.terminal.resize(30, 8);
			assert.strictEqual(resized.tui.requestComponentRender(resized.descendant), false);
			await resized.terminal.waitForRender();

			assert.strictEqual(resized.descendant.renderCount, resizedDescendantCount + 1);
			assert.strictEqual(resized.unrelated.renderCount, resizedUnrelatedCount + 1);
			assert.strictEqual(resized.terminal.getViewport()[0], "resized region");
		} finally {
			await stopFixture(resized);
		}

		const overlay = await startFixture();
		try {
			const overlayComponent = new RenderCountingComponent(["visible overlay"]);
			const overlayHandle = overlay.tui.showOverlay(overlayComponent, { row: 0, col: 0, width: 16 });
			await overlay.terminal.waitForRender();
			overlay.terminal.clearWrites();
			const unrelatedRenderCount = overlay.unrelated.renderCount;
			overlay.descendant.lines = ["covered region", "covered second"];

			assert.strictEqual(overlay.tui.requestComponentRender(overlay.descendant), false);
			await overlay.terminal.waitForRender();

			assert.ok(overlay.terminal.getViewport()[0]?.startsWith("visible overlay"));
			assert.ok(overlay.unrelated.renderCount > unrelatedRenderCount);
			assert.ok(overlay.terminal.getWrites().length > 0);
			overlayHandle.hide();
			await overlay.terminal.waitForRender();
		} finally {
			await stopFixture(overlay);
		}
	});

	it("rejects a placement not refreshed by the latest root render", async () => {
		const terminal = new LoggingVirtualTerminal(24, 8);
		const tui = new TUI(terminal);
		const regionRoot = new Container();
		const descendant = new RenderCountingComponent(["region"]);
		const unrelated = new RenderCountingComponent(["unrelated"]);
		regionRoot.addChild(descendant);
		const region = tui.createRenderRegion(regionRoot);
		let reportLayout = true;
		const root = new RootCompositor({
			getHeight: () => terminal.rows,
			flow: [
				{
					component: regionRoot,
					onLayout: (rect) => {
						if (reportLayout) region.place(rect);
					},
				},
				{ component: unrelated },
			],
			bottom: [],
		});
		tui.addChild(root);
		tui.start();
		await terminal.waitForRender();

		reportLayout = false;
		tui.requestRender();
		await terminal.waitForRender();
		const unrelatedRenderCount = unrelated.renderCount;
		descendant.lines = ["stale update"];

		assert.strictEqual(tui.requestComponentRender(descendant), false);
		await terminal.waitForRender();

		assert.ok(unrelated.renderCount > unrelatedRenderCount);
		assert.strictEqual(terminal.getViewport()[0], "stale update");
		tui.stop();
		await terminal.flush();
	});

	it("falls back to normal rendering for an unregistered component", async () => {
		const fixture = await startFixture();
		try {
			const unregistered = new RenderCountingComponent(["not in the root"]);
			const descendantRenderCount = fixture.descendant.renderCount;
			const unrelatedRenderCount = fixture.unrelated.renderCount;
			assert.strictEqual(fixture.tui.requestComponentRender(unregistered), false);
			await fixture.terminal.waitForRender();

			assert.strictEqual(fixture.descendant.renderCount, descendantRenderCount + 1);
			assert.strictEqual(fixture.unrelated.renderCount, unrelatedRenderCount + 1);
			assert.deepStrictEqual(fixture.terminal.getViewport().slice(0, 3), [
				"region one",
				"region two",
				"unrelated row",
			]);
		} finally {
			await stopFixture(fixture);
		}
	});
});
