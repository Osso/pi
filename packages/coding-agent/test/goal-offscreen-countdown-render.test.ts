import { Container, Loader, Text, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createSupervisorStatusEntryRenderer } from "../extensions/goal/src/rendering.ts";
import { createWaitCountdownRefresher } from "../extensions/goal/src/wait-countdown.ts";
import { createEndTurnToolDefinition } from "../src/core/tools/end-turn.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { RenderRegionContainer } from "../src/modes/interactive/components/render-region-container.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveRootCompositor } from "../src/modes/interactive/interactive-root-compositor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const START = Date.parse("2026-10-19T18:41:00Z");
const completionClock = new Date(START + 1000).toLocaleTimeString("en-GB");

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

async function createFixture(historyRows = 100) {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TUI(terminal);
	tui.setClearOnShrink(false);
	const chat = new RenderRegionContainer(tui);
	const refresher = createWaitCountdownRefresher();
	let tick: () => boolean = () => {
		throw new Error("Countdown not bound");
	};
	const bind = refresher.bind.bind(refresher);
	vi.spyOn(refresher, "bind").mockImplementation((sessionId, reviewAt, requestRender) => {
		tick = requestRender;
		return bind(sessionId, reviewAt, requestRender);
	});
	const entry = new CustomEntryComponent(
		{
			type: "custom",
			id: "old-review",
			parentId: null,
			timestamp: new Date(START).toISOString(),
			customType: "supervisor-status",
			data: { message: "Waiting for child agents", reviewAt: new Date(START + 60_000).toISOString() },
		},
		createSupervisorStatusEntryRenderer(refresher),
		{
			sessionId: "countdown-regression",
			requestRender: (child) => chat.requestChildRender(child),
		},
	);
	chat.addChild(entry);
	chat.trackScopedChild(entry);
	for (let index = 0; index < historyRows; index++) chat.addChild(new Text(`later history ${index}`, 0, 0));
	const tool = new ToolExecutionComponent(
		"end_turn",
		"finish-turn",
		{ reason: "Regression complete" },
		{ hideOutput: true },
		createEndTurnToolDefinition(),
		tui,
		process.cwd(),
	);
	tool.markExecutionStarted(START);
	chat.addChild(tool);
	const status = new Container();
	const loader = new Loader(
		tui,
		(text) => text,
		(text) => text,
		"Thinking...",
		{ frames: [] },
	);
	status.addChild(loader);
	const root = createInteractiveRootCompositor({
		getHeight: () => terminal.rows,
		header: new Container(),
		loadedResources: new Container(),
		chat,
		onChatLayout: (rect) => chat.place(rect),
		transcriptTail: new Container(),
		onTranscriptTailLayout: () => {},
		pendingMessages: new Container(),
		status,
		onStatusLayout: () => {},
		widgetAbove: new Container(),
		editor: new Text("editor ready", 0, 0),
		onEditorLayout: () => {},
		widgetBelow: new Container(),
		footer: new Text("footer ready", 0, 0),
	});
	tui.addChild(root);
	tui.start();
	await terminal.waitForRender();
	const initialHeight = root.render(80).length;
	const pendingToolHeight = tool.render(80).length;
	expect(loader.render(80)).toHaveLength(2);
	terminal.writes = [];
	return {
		terminal,
		tui,
		tick: () => tick(),
		async complete() {
			tool.updateResult(
				{
					content: [{ type: "text", text: "Turn ended: Regression complete" }],
					details: { reason: "Regression complete" },
					isError: false,
				},
				false,
				START + 1000,
			);
			expect(tool.render(80)).toHaveLength(pendingToolHeight + 2);
			// tool_execution_end adds two timing rows; agent_end removes the two-row loader.
			loader.stop();
			status.clear();
			tui.requestRender();
			await terminal.waitForRender();
			expect(root.render(80)).toHaveLength(initialHeight);
		},
		async dispose() {
			refresher.clearAll();
			loader.stop();
			chat.clear();
			tui.stop();
			await terminal.flush();
		},
	};
}

describe("offscreen Supervisor countdown at end_turn completion", () => {
	beforeEach(() => {
		initTheme("dark");
		// Keep the real TUI/xterm scheduling; only the countdown and completion clock are fake.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("same-height completion updates the live viewport without replaying offscreen history", async () => {
		const fixture = await createFixture();
		try {
			const redraws = fixture.tui.fullRedraws;
			vi.setSystemTime(START + 1000);
			expect(fixture.tick()).toBe(false);
			expect(fixture.terminal.writes).toEqual([]);
			await fixture.complete();
			const viewport = fixture.terminal.getViewport().join("\n");
			for (const text of ["end_turn", "Elapsed: 1s", completionClock, "editor ready", "footer ready"]) {
				expect(viewport).toContain(text);
			}
			expect(viewport).not.toContain("Thinking...");
			const output = fixture.terminal.writes.join("");
			expect({
				fullRedrawDelta: fixture.tui.fullRedraws - redraws,
				clears: output.match(/\x1b\[[23]J/g) ?? [],
				supervisorReplay: output.includes("[Supervisor]") || output.includes("Waiting for child agents"),
				historyRows: output.match(/later history \d+/g)?.length ?? 0,
			}).toEqual({ fullRedrawDelta: 0, clears: [], supervisorReplay: false, historyRows: 0 });
		} finally {
			await fixture.dispose();
		}
	});

	test("an explicitly forced rebuild still writes the full earlier backlog", async () => {
		const fixture = await createFixture();
		try {
			const expectedHistory = Array.from({ length: 100 }, (_, index) => `later history ${index}`);
			expect(
				fixture.terminal
					.getScrollBuffer()
					.filter((line) => line.startsWith("later history"))
					.map((line) => line.trimEnd()),
			).toEqual(expectedHistory);
			vi.setSystemTime(START + 1000);
			expect(fixture.tick()).toBe(false);
			expect(fixture.terminal.writes).toEqual([]);
			fixture.tui.invalidate();
			fixture.tui.requestRender(true);
			await fixture.terminal.waitForRender();
			const output = fixture.terminal.writes.join("");
			expect(output).toContain("\x1b[2J");
			expect(output).toContain("Waiting for child agents");
			expect(output.match(/later history \d+/g)).toHaveLength(100);
			expect(
				fixture.terminal
					.getScrollBuffer()
					.filter((line) => line.startsWith("later history"))
					.map((line) => line.trimEnd()),
			).toEqual(expectedHistory);
		} finally {
			await fixture.dispose();
		}
	});

	test("visible countdown ticks advance and resume after a rebuild", async () => {
		const fixture = await createFixture(0);
		try {
			vi.setSystemTime(START + 1000);
			expect(fixture.tick()).toBe(true);
			await fixture.terminal.flush();
			expect(fixture.terminal.getViewport().join("\n")).toContain("Next review in 0:59");
			fixture.tui.invalidate();
			fixture.tui.requestRender(true);
			await fixture.terminal.waitForRender();
			vi.setSystemTime(START + 2000);
			expect(fixture.tick()).toBe(true);
			await fixture.terminal.flush();
			expect(fixture.terminal.getViewport().join("\n")).toContain("Next review in 0:58");
			vi.setSystemTime(START + 60_000);
			expect(fixture.tick()).toBe(true);
			await fixture.terminal.flush();
			expect(fixture.terminal.getViewport().join("\n")).toContain("Review due…");
		} finally {
			await fixture.dispose();
		}
	});
});
