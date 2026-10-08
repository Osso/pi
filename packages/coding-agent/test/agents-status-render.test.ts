import { type Component, Container, type Terminal, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentsStatusComponent } from "../extensions/agents-status/src/index.ts";
import type { AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { RenderRegionContainer } from "../src/modes/interactive/components/render-region-container.ts";
import { createInteractiveRootCompositor } from "../src/modes/interactive/interactive-root-compositor.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

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

function runningAgent(): AgentSnapshot {
	return {
		id: "agent_1",
		parentId: undefined,
		displayName: "sleep-check",
		agentType: "test",
		lifecycle: "running",
		revision: 1,
		createdAt: "2026-10-08T12:00:00.000Z",
		updatedAt: "2026-10-08T12:00:00.000Z",
		cwd: "/repo",
		permission: { policy: "on-request", narrowed: true },
		currentActivity: {
			phase: "tool",
			startedAt: "2026-10-08T12:00:00.000Z",
			toolCallId: "call-1",
			toolName: "bash",
			detail: "sleep 25",
		},
	};
}

function fakeStore(agents: AgentSnapshot[]): MultiAgentStore {
	return {
		listAgents: () => agents,
		subscribeAgentUpdates: () => () => {},
	} as unknown as MultiAgentStore;
}

async function flushRender(): Promise<void> {
	await vi.advanceTimersByTimeAsync(20);
}

describe("agents status widget rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("advances elapsed time in place without redrawing the chat", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T12:00:05.000Z"));
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const staticBody = new RenderCountingComponent(
			Array.from({ length: 24 }, (_, index) => `static conversation line ${index + 1}`),
		);
		const chat = new RenderRegionContainer(tui);
		chat.addChild(staticBody);
		const widget = createAgentsStatusComponent(fakeStore([runningAgent()]), tui, theme);
		const widgetAbove = new Container();
		widgetAbove.addChild(widget);
		const widgetAboveRegion = tui.createRenderRegion(widgetAbove);
		const compositor = createInteractiveRootCompositor({
			getHeight: () => terminal.rows,
			header: new Container(),
			loadedResources: new Container(),
			chat,
			onChatLayout: (layout) => chat.place(layout),
			transcriptTail: new Container(),
			pendingMessages: new Container(),
			onTranscriptTailLayout: () => {},
			status: new Container(),
			widgetAbove,
			editor: new RenderCountingComponent(["editor"]),
			widgetBelow: new Container(),
			footer: new RenderCountingComponent(["footer"]),
			onStatusLayout: () => {},
			onWidgetAboveLayout: widgetAboveRegion.place,
			onEditorLayout: () => {},
		});
		tui.addChild(compositor);
		tui.start();
		await flushRender();

		expect(terminal.writes.join("")).toContain("bash sleep 25");
		terminal.writes = [];
		const staticBodyRenderCount = staticBody.renderCount;
		const initialFullRedraws = tui.fullRedraws;

		try {
			await vi.advanceTimersByTimeAsync(1_000);
			await flushRender();

			const tickWrites = terminal.writes.join("");
			expect(tickWrites).toContain("6s");
			expect(tickWrites).not.toContain("static conversation line");
			expect(tickWrites).not.toContain("\x1b[2J");
			expect(tui.fullRedraws).toBe(initialFullRedraws);
			expect(staticBody.renderCount).toBe(staticBodyRenderCount);
		} finally {
			widget.dispose();
			tui.stop();
		}
	});
});
