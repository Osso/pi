import { Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createSupervisorStatusEntryRenderer } from "../extensions/goal/src/rendering.ts";
import { createWaitCountdownRefresher } from "../extensions/goal/src/wait-countdown.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { EntryRenderer } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { RenderRegionContainer } from "../src/modes/interactive/components/render-region-container.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const SUPERVISOR_MESSAGE = "Waiting: exact-equivalence reconciliation is still active.";

interface CustomEntryRenderingThis {
	chatContainer: RenderRegionContainer;
	completedToolTimings: Map<string, { startedAt: number; finishedAt: number }>;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	footer: { invalidate(): void };
	isInitialized: boolean;
	multiAgentStore: undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	runtimeHost: {
		session: {
			extensionRunner: { getEntryRenderer(customType: string): EntryRenderer | undefined };
			retryAttempt: number;
			sessionManager: { getCwd(): string; getSessionId(): string };
			settingsManager: { getHideToolOutput(): boolean; getImageWidthCells(): number; getShowImages(): boolean };
		};
	};
	toolOutputExpanded: boolean;
	ui: Pick<TUI, "requestRender">;
}

type HandleEvent = (this: CustomEntryRenderingThis, event: AgentSessionEvent) => Promise<void>;
type RenderSessionEntries = (this: CustomEntryRenderingThis, entries: SessionEntry[]) => void;

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
const renderSessionEntries = (InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries })
	.renderSessionEntries;

const supervisorStatusRenderer: EntryRenderer = (entry) => {
	const data = entry.data as { message: string };
	return new Text(`[Supervisor]\n${data.message}`, 0, 0);
};

function createSupervisorStatusEntry(): SessionEntry {
	return {
		type: "custom",
		customType: "supervisor-status",
		data: { message: SUPERVISOR_MESSAGE },
		id: "supervisor-status-1",
		parentId: null,
		timestamp: new Date().toISOString(),
	};
}

function createFakeChatContainer(): RenderRegionContainer {
	return new RenderRegionContainer({
		createRenderRegion: () => ({
			clear: () => {},
			dispose: () => {},
			place: () => {},
			requestRender: () => false,
			tryRender: () => false,
		}),
	});
}

function createFakeInteractiveModeThis(renderer: EntryRenderer = supervisorStatusRenderer): CustomEntryRenderingThis {
	return Object.assign(Object.create(InteractiveMode.prototype) as CustomEntryRenderingThis, {
		chatContainer: createFakeChatContainer(),
		completedToolTimings: new Map<string, { startedAt: number; finishedAt: number }>(),
		executingToolNames: new Map<string, string>(),
		executingToolStartedAt: new Map<string, number>(),
		footer: { invalidate: vi.fn() },
		isInitialized: true,
		multiAgentStore: undefined,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		runtimeHost: {
			session: {
				extensionRunner: {
					getEntryRenderer: (customType: string) => (customType === "supervisor-status" ? renderer : undefined),
				},
				retryAttempt: 0,
				sessionManager: { getCwd: () => process.cwd(), getSessionId: () => "session-1" },
				settingsManager: {
					getHideToolOutput: () => false,
					getImageWidthCells: () => 40,
					getShowImages: () => false,
				},
			},
		},
		toolOutputExpanded: false,
		ui: { requestRender: vi.fn() },
	});
}

function renderChat(container: RenderRegionContainer): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode custom entry rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders a custom entry appended after the model turn", async () => {
		const fakeThis = createFakeInteractiveModeThis();

		await handleEvent.call(fakeThis, {
			type: "entry_appended",
			entry: createSupervisorStatusEntry(),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain(SUPERVISOR_MESSAGE);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("renders persisted custom entries when rebuilding the transcript", () => {
		const fakeThis = createFakeInteractiveModeThis();

		renderSessionEntries.call(fakeThis, [createSupervisorStatusEntry()]);

		expect(renderChat(fakeThis.chatContainer)).toContain(SUPERVISOR_MESSAGE);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("replaces waiting with a multiline answer in the same live Supervisor block", async () => {
		const renderer = createSupervisorStatusEntryRenderer(createWaitCountdownRefresher());
		const fakeThis = createFakeInteractiveModeThis(renderer);
		const waiting = createSupervisorStatusEntry();
		if (waiting.type !== "custom") throw new Error("expected custom entry");
		waiting.data = { displayId: "review-1", message: "Waiting for Supervisor…" };
		const persistedWaiting = JSON.stringify(waiting);
		await handleEvent.call(fakeThis, { type: "entry_appended", entry: waiting });
		const originalBlock = fakeThis.chatContainer.children[0];
		expect(renderChat(fakeThis.chatContainer)).toContain("Waiting for Supervisor…");

		await handleEvent.call(fakeThis, {
			type: "entry_appended",
			entry: {
				...waiting,
				id: "answer-1",
				data: { displayId: "review-1", message: "Run regression.\nThen inspect output.\nPreserve full scope." },
			},
		});

		const rendered = renderChat(fakeThis.chatContainer);
		expect(fakeThis.chatContainer.children).toEqual([originalBlock]);
		expect(rendered.match(/\[Supervisor\]/g)).toHaveLength(1);
		expect(rendered).not.toContain("Waiting for Supervisor…");
		expect(rendered).toContain("Run regression.");
		expect(rendered).toContain("Then inspect output.");
		expect(rendered).toContain("Preserve full scope.");
		expect(JSON.stringify(waiting)).toBe(persistedWaiting);
		fakeThis.chatContainer.invalidate();
		expect(renderChat(fakeThis.chatContainer)).toContain("Preserve full scope.");
	});

	test("reload groups persisted review entries without merging separate reviews or unrelated statuses", () => {
		const renderer = createSupervisorStatusEntryRenderer(createWaitCountdownRefresher());
		const fakeThis = createFakeInteractiveModeThis(renderer);
		const waiting = createSupervisorStatusEntry();
		if (waiting.type !== "custom") throw new Error("expected custom entry");
		const entries: SessionEntry[] = [
			{ ...waiting, id: "waiting-1", data: { displayId: "review-1", message: "Waiting for Supervisor…" } },
			{ ...waiting, id: "answer-1", data: { displayId: "review-1", message: "Run regression.\nInspect output." } },
			{ ...waiting, id: "unrelated", data: { message: "Goal wait failed: discovery unavailable" } },
			{ ...waiting, id: "waiting-2", data: { displayId: "review-2", message: "Waiting for Supervisor…" } },
			{ ...waiting, id: "answer-2", data: { displayId: "review-2", message: "Goal complete: verified" } },
		];
		const persisted = JSON.stringify(entries);
		renderSessionEntries.call(fakeThis, entries);
		const rendered = renderChat(fakeThis.chatContainer);
		expect(rendered.match(/\[Supervisor\]/g)).toHaveLength(3);
		expect(rendered).not.toContain("Waiting for Supervisor…");
		expect(rendered).toContain("Inspect output.");
		expect(rendered).toContain("Goal wait failed: discovery unavailable");
		expect(rendered).toContain("Goal complete: verified");
		expect(JSON.stringify(entries)).toBe(persisted);
	});

	test("replays a waiting-only branch without leaking its future answer or countdown", async () => {
		const refresher = createWaitCountdownRefresher();
		const fakeThis = createFakeInteractiveModeThis(createSupervisorStatusEntryRenderer(refresher));
		const waiting = createSupervisorStatusEntry();
		if (waiting.type !== "custom") throw new Error("expected custom entry");
		waiting.data = { displayId: "review-1", message: "Waiting for Supervisor…" };
		const answer = {
			...waiting,
			id: "answer-1",
			data: {
				displayId: "review-1",
				message: "Future answer absent from rewound branch.",
				reviewAt: "2099-01-01T00:00:00.000Z",
			},
		};
		await handleEvent.call(fakeThis, { type: "entry_appended", entry: waiting });
		await handleEvent.call(fakeThis, { type: "entry_appended", entry: answer });
		const block = fakeThis.chatContainer.children[0];
		if (!(block instanceof CustomEntryComponent)) throw new Error("expected Supervisor custom component");
		block.setExpanded(true);
		expect(renderChat(fakeThis.chatContainer)).toContain(answer.data.message);
		fakeThis.chatContainer.invalidate();
		expect(renderChat(fakeThis.chatContainer)).toContain(answer.data.message);
		expect(renderChat(fakeThis.chatContainer)).toContain("Next review in");

		fakeThis.chatContainer.clear();
		renderSessionEntries.call(fakeThis, [waiting]);
		const rewound = renderChat(fakeThis.chatContainer);
		expect(rewound).toContain("Waiting for Supervisor…");
		expect(rewound).not.toContain(answer.data.message);
		expect(rewound).not.toContain("Next review");
		expect(rewound.match(/\[Supervisor\]/g)).toHaveLength(1);

		fakeThis.chatContainer.clear();
		renderSessionEntries.call(fakeThis, [waiting, answer]);
		const restored = renderChat(fakeThis.chatContainer);
		expect(restored).toContain(answer.data.message);
		expect(restored).toContain("Next review in");
		expect(restored).not.toContain("Waiting for Supervisor…");
		expect(restored.match(/\[Supervisor\]/g)).toHaveLength(1);
		fakeThis.chatContainer.clear();
		refresher.clearAll();
	});

	test("retires each replaced render resource without cleaning up its replacement", async () => {
		const released: number[] = [];
		let nextResourceId = 0;
		const renderer: EntryRenderer = (_entry, options) => {
			const resourceId = ++nextResourceId;
			options.registerCleanup?.(() => released.push(resourceId));
			return new Text(`resource ${resourceId}: ${options.expanded ? "expanded" : "collapsed"}`, 0, 0);
		};
		const fakeThis = createFakeInteractiveModeThis(renderer);
		await handleEvent.call(fakeThis, { type: "entry_appended", entry: createSupervisorStatusEntry() });
		expect(released).toEqual([]);
		const block = fakeThis.chatContainer.children[0];
		if (!(block instanceof CustomEntryComponent)) throw new Error("expected custom entry component");
		block.setExpanded(true);
		expect(renderChat(fakeThis.chatContainer)).toContain("resource 2: expanded");
		expect(released).toEqual([1]);
		fakeThis.chatContainer.invalidate();
		expect(renderChat(fakeThis.chatContainer)).toContain("resource 3: expanded");
		expect(released).toEqual([1, 2]);
		fakeThis.chatContainer.clear();
		expect(released).toEqual([1, 2, 3]);
	});

	test("cleans up state registered by a rendered custom entry", async () => {
		const cleanup = vi.fn();
		const renderer: EntryRenderer = (_entry, options) => {
			options.registerCleanup?.(cleanup);
			return new Text("status", 0, 0);
		};
		const fakeThis = createFakeInteractiveModeThis(renderer);

		await handleEvent.call(fakeThis, {
			type: "entry_appended",
			entry: createSupervisorStatusEntry(),
		});
		fakeThis.chatContainer.clear();

		expect(cleanup).toHaveBeenCalledOnce();
	});
});
