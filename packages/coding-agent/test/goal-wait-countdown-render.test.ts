import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Loader, type Terminal, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupervisorStatusEntryRenderer } from "../extensions/goal/src/rendering.ts";
import { createWaitCountdownRefresher } from "../extensions/goal/src/wait-countdown.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { RenderRegionContainer } from "../src/modes/interactive/components/render-region-container.ts";
import { createInteractiveRootCompositor } from "../src/modes/interactive/interactive-root-compositor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class RenderCountingComponent implements Component {
	readonly lines: string[];
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

class FakeTerminal implements Terminal {
	columns = 60;
	rows = 18;
	kittyProtocolActive = false;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

async function flushRender(): Promise<void> {
	await vi.advanceTimersByTimeAsync(20);
}

describe("goal Supervisor countdown rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("advances beside Thinking elapsed status without rendering static chat again", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const staticHeader = new RenderCountingComponent(["static header"]);
		const staticBody = new RenderCountingComponent(
			Array.from({ length: 24 }, (_, index) => `static conversation line ${index + 1}`),
		);
		const chat = new RenderRegionContainer(tui);
		chat.addChild(staticBody);

		const reviewAt = "2026-08-17T12:00:05.000Z";
		const refresher = createWaitCountdownRefresher();
		const renderer = createSupervisorStatusEntryRenderer(refresher);
		const supervisorStatus = new CustomEntryComponent(
			{
				type: "custom",
				id: "supervisor-status-1",
				parentId: null,
				timestamp: "2026-08-17T12:00:00.000Z",
				customType: "supervisor-status",
				data: { message: "Waiting for child agents", reviewAt },
			},
			renderer,
			{
				requestRender: (child) => chat.requestChildRender(child),
				sessionId: "session-1",
			},
		);
		chat.addChild(supervisorStatus);
		chat.trackScopedChild(supervisorStatus);

		const status = new Container();
		const thinkingLoader = new Loader(
			tui,
			(text) => text,
			(text) => text,
			"Thinking... 14s",
			{ frames: [] },
		);
		status.addChild(thinkingLoader);
		const statusRegion = tui.createRenderRegion(status);
		const compositor = createInteractiveRootCompositor({
			getHeight: () => terminal.rows,
			header: staticHeader,
			loadedResources: new Container(),
			chat,
			onChatLayout: (layout) => chat.place(layout),
			transcriptTail: new Container(),
			pendingMessages: new Container(),
			onTranscriptTailLayout: () => {},
			status,
			widgetAbove: new Container(),
			editor: new RenderCountingComponent(["editor"]),
			widgetBelow: new Container(),
			footer: new RenderCountingComponent(["footer"]),
			onStatusLayout: statusRegion.place,
			onEditorLayout: () => {},
		});
		tui.addChild(compositor);
		tui.start();
		await flushRender();

		const initialWrites = terminal.writes.join("");
		expect(initialWrites).toContain("Next review in 0:05");
		expect(initialWrites).toContain("Thinking... 14s");
		terminal.writes = [];
		const staticHeaderRenderCount = staticHeader.renderCount;
		const staticBodyRenderCount = staticBody.renderCount;
		const initialFullRedraws = tui.fullRedraws;
		const ctx = {
			sessionManager: { getSessionId: () => "session-1" },
		} as unknown as ExtensionContext;

		try {
			refresher.start(ctx, reviewAt);
			setTimeout(() => thinkingLoader.setMessage("Thinking... 15s"), 1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await flushRender();

			const countdownWrites = terminal.writes.join("");
			expect(countdownWrites).toContain("Next review in 0:04");
			expect(countdownWrites).toContain("Thinking... 15s");
			expect(countdownWrites).not.toContain("static conversation line");
			expect(countdownWrites).not.toContain("\x1b[2J");
			expect(countdownWrites).not.toContain("\x1b[3J");
			expect(tui.fullRedraws).toBe(initialFullRedraws);
			expect(staticHeader.renderCount).toBe(staticHeaderRenderCount);
			expect(staticBody.renderCount).toBe(staticBodyRenderCount);
		} finally {
			refresher.clearAll();
			thinkingLoader.stop();
			chat.clear();
			tui.stop();
		}
	});
});
