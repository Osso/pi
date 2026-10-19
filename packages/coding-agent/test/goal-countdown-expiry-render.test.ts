import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createSupervisorStatusEntryRenderer } from "../extensions/goal/src/rendering.ts";
import { createWaitCountdownRefresher } from "../extensions/goal/src/wait-countdown.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { RenderRegionContainer } from "../src/modes/interactive/components/render-region-container.ts";
import { createInteractiveRootCompositor } from "../src/modes/interactive/interactive-root-compositor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const DEADLINE = Date.parse("2026-10-19T18:42:00Z");
const REVIEW_AT = new Date(DEADLINE).toISOString();

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

async function createFixture(width: number, queueRootAtExpiry: boolean) {
	const terminal = new RecordingTerminal(width, 24);
	const tui = new TUI(terminal);
	tui.setClearOnShrink(false);
	const chat = new RenderRegionContainer(tui);
	const refresher = createWaitCountdownRefresher();
	for (let index = 0; index < 30; index++) chat.addChild(new Text(`history ${index}`, 0, 0));
	let queued = false;
	const entry = new CustomEntryComponent(
		{
			type: "custom",
			id: "expiry",
			parentId: null,
			timestamp: new Date(DEADLINE - 1_000).toISOString(),
			customType: "supervisor-status",
			data: { message: "Waiting for child agents", reviewAt: REVIEW_AT },
		},
		createSupervisorStatusEntryRenderer(refresher),
		{
			sessionId: "expiry-regression",
			requestRender: (child) => {
				// Reproduce an unrelated root frame queued immediately before the expiry repaint.
				if (queueRootAtExpiry && !queued && Date.now() >= DEADLINE) {
					queued = true;
					tui.requestRender();
				}
				return chat.requestChildRender(child);
			},
		},
	);
	chat.addChild(entry);
	chat.trackScopedChild(entry);
	tui.addChild(
		createInteractiveRootCompositor({
			getHeight: () => terminal.rows,
			header: new Container(),
			loadedResources: new Container(),
			chat,
			onChatLayout: (rect) => chat.place(rect),
			transcriptTail: new Container(),
			onTranscriptTailLayout: () => {},
			pendingMessages: new Container(),
			status: new Container(),
			onStatusLayout: () => {},
			widgetAbove: new Container(),
			editor: new Text("editor", 0, 0),
			onEditorLayout: () => {},
			widgetBelow: new Container(),
			footer: new Text("footer", 0, 0),
		}),
	);
	tui.start();
	await terminal.waitForRender();
	terminal.writes = [];
	return {
		terminal,
		tui,
		chat,
		clearSession: () => refresher.clearSession("expiry-regression"),
		removeBinding: () => entry.dispose(),
		start() {
			refresher.start(
				{ sessionManager: { getSessionId: () => "expiry-regression" } } as unknown as ExtensionContext,
				REVIEW_AT,
			);
		},
		async dispose() {
			refresher.clearAll();
			chat.clear();
			tui.stop();
			await terminal.flush();
		},
	};
}

describe("Supervisor countdown expiry through the live timer", () => {
	beforeEach(() => {
		initTheme("dark");
		// Preserve real timeout scheduling and xterm's asynchronous write queue.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(DEADLINE - 1_000);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	for (const [name, width, queueRoot] of [
		["retries expiry after an already queued root render", 80, true],
		["shows expiry when the wrapped countdown label shrinks at width 18", 18, false],
	] as const) {
		test(name, async () => {
			const fixture = await createFixture(width, queueRoot);
			try {
				expect(fixture.terminal.getViewport().join("\n")).toContain("0:01");
				const redraws = fixture.tui.fullRedraws;
				const requests = vi.spyOn(fixture.tui, "requestRender");
				fixture.start();
				vi.setSystemTime(DEADLINE);
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				await fixture.terminal.waitForRender();
				// One existing one-second retry is allowed; no new review deadline or root fallback.
				vi.setSystemTime(DEADLINE + 1_000);
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				await fixture.terminal.waitForRender();
				expect(requests).toHaveBeenCalledTimes(queueRoot ? 1 : 0);
				const output = fixture.terminal.writes.join("");
				expect(output).not.toMatch(/\x1b\[[23]J/);
				expect(output).not.toContain("history ");
				expect(fixture.tui.fullRedraws).toBe(redraws);
				const viewport = fixture.terminal.getViewport().join("\n");
				expect(viewport).toContain("Review due…");
				expect(viewport).not.toContain("0:01");
				expect(viewport).toContain("editor");
				expect(viewport).toContain("footer");
				if (width === 18) {
					for (const columns of [80, 18]) {
						fixture.terminal.resize(columns, 24);
						await fixture.terminal.waitForRender();
						const resized = fixture.terminal.getViewport().join("\n");
						for (const label of ["Review due…", "editor", "footer"]) expect(resized).toContain(label);
					}
				}
			} finally {
				await fixture.dispose();
			}
		});
	}

	test("stops rejected expiry retries when cancelled or its renderer binding is removed", async () => {
		const cancelled = await createFixture(80, true);
		const unbound = await createFixture(80, true);
		const fixtures = [cancelled, unbound];
		try {
			const attempts = fixtures.map(({ chat }) => vi.spyOn(chat, "requestChildRender"));
			for (const fixture of fixtures) fixture.start();
			vi.setSystemTime(DEADLINE);
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			await Promise.all(fixtures.map(({ terminal }) => terminal.waitForRender()));
			for (const attempt of attempts) {
				expect(attempt).toHaveBeenCalledTimes(1);
				expect(attempt.mock.results[0]?.value).toBe(false);
				attempt.mockClear();
			}
			cancelled.clearSession();
			unbound.removeBinding();
			const rootRequests = fixtures.map(({ tui }) => vi.spyOn(tui, "requestRender"));
			for (const fixture of fixtures) fixture.terminal.writes = [];
			vi.setSystemTime(DEADLINE + 2_000);
			await new Promise((resolve) => setTimeout(resolve, 2_100));
			await Promise.all(fixtures.map(({ terminal }) => terminal.waitForRender()));
			expect({
				scopedAttempts: attempts.map((attempt) => attempt.mock.calls.length),
				rootRequests: rootRequests.map((request) => request.mock.calls.length),
				writes: fixtures.map(({ terminal }) => terminal.writes),
			}).toEqual({ scopedAttempts: [0, 0], rootRequests: [0, 0], writes: [[], []] });
		} finally {
			await Promise.all(fixtures.map((fixture) => fixture.dispose()));
		}
	});
});
