import { beforeAll, describe, expect, test, vi } from "vitest";
import { formatCompactionStartLabel, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode compaction events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows Ollama local source in the in-progress compaction label", () => {
		expect(
			formatCompactionStartLabel(
				"manual",
				{ type: "local", provider: "ollama", model: "gpt-oss:20b" },
				"(escape to cancel)",
			),
		).toBe("Compacting context via Ollama model (ollama/gpt-oss:20b)... (escape to cancel)");
	});

	test("shows Ollama local source in the in-progress compaction loader", async () => {
		const addedChildren: Array<{ render: (width: number) => string[]; stop?: () => void }> = [];
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: {
				clear: vi.fn(),
				addChild: vi.fn((child: { render: (width: number) => string[]; stop?: () => void }) => {
					addedChildren.push(child);
				}),
			},
			settingsManager: { getShowTerminalProgress: () => false },
			session: { abortCompaction: vi.fn() },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_start";
				reason: "manual";
				sourceHint: { type: "local"; provider: string; model: string };
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_start",
			reason: "manual",
			sourceHint: { type: "local", provider: "ollama", model: "gpt-oss:20b" },
		});

		const renderedLoader = addedChildren[0]?.render(120).join("\n") ?? "";
		expect(renderedLoader).toContain("Compacting context via Ollama model (ollama/gpt-oss:20b)...");
	});

	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result:
					| {
							tokensBefore: number;
							summary: string;
							durationMs?: number;
							source?: { type: "local"; provider: string; model: string };
					  }
					| undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				durationMs: 4567,
				source: { type: "local", provider: "ollama", model: "gpt-oss:20b" },
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
				durationMs: 4567,
			}),
		);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Compaction completed via Ollama model (ollama/gpt-oss:20b)");
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("logs Ollama compaction source", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: {
					tokensBefore: number;
					summary: string;
					source?: { type: "local"; provider: string; model: string };
				};
				aborted: boolean;
				willRetry: boolean;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				source: { type: "local", provider: "ollama", model: "gpt-oss:20b" },
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Compaction completed via Ollama model (ollama/gpt-oss:20b)");
	});
});
