import { Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { EntryRenderer } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
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
			settingsManager: { getImageWidthCells(): number; getShowImages(): boolean };
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
				settingsManager: { getImageWidthCells: () => 40, getShowImages: () => false },
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
