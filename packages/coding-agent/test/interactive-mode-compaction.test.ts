import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { buildContextEntries, type SessionEntry } from "../src/core/session-manager.ts";
import {
	formatCompactionFailureMessage,
	formatCompactionStartLabel,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function userEntry(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-08T00:00:00.000Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-08T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

class WorkingEditor {
	working = false;

	render(): string[] {
		return [];
	}
	invalidate(): void {}
	handleInput(): void {}
	getText(): string {
		return "";
	}
	setText(): void {}
	setWorking(working: boolean): void {
		this.working = working;
	}
	setWorkingIndicator(): void {}
	setScreenOrigin(): void {}
	clearScreenOrigin(): void {}
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	test("shows OpenAI remote endpoint in the in-progress compaction label", () => {
		expect(
			formatCompactionStartLabel(
				"manual",
				{
					type: "openai_remote",
					provider: "openai-codex",
					model: "gpt-5.5",
					endpoint: "https://chatgpt.com/backend-api/codex/responses/compact",
				},
				"(escape to cancel)",
			),
		).toBe(
			"Compacting context via OpenAI remote endpoint (openai-codex/gpt-5.5, https://chatgpt.com/backend-api/codex/responses/compact)... (escape to cancel)",
		);
	});

	test("shows local source in the in-progress compaction label", () => {
		expect(
			formatCompactionStartLabel(
				"threshold",
				{ type: "local", provider: "anthropic", model: "claude-sonnet-4-5" },
				"(escape to cancel)",
			),
		).toBe("Auto-compacting locally... (escape to cancel)");
	});

	test("shows remote source without periodically rerendering the compaction label", async () => {
		vi.useFakeTimers();
		const addedChildren: Array<{ render: (width: number) => string[]; stop?: () => void }> = [];
		const editor = new WorkingEditor();
		const fakeThis = {
			isInitialized: true,
			isViewingAgentSession: () => false,
			isSelectedChildWorking: () => false,
			handleHiddenMainSessionDisplayEvent: Reflect.get(
				InteractiveMode.prototype,
				"handleHiddenMainSessionDisplayEvent",
			),
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			autoCompactionSourceHint: undefined,
			defaultEditor: {},
			editor,
			editorContainer: { children: [editor] },
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			promptActivitySources: new Set<string>(),
			setPromptActivity: Reflect.get(InteractiveMode.prototype, "setPromptActivity"),
			showError: vi.fn(),
			statusContainer: {
				clear: vi.fn(),
				addChild: vi.fn((child: { render: (width: number) => string[]; stop?: () => void }) => {
					addedChildren.push(child);
				}),
			},
			syncWorkingEditorState: Reflect.get(InteractiveMode.prototype, "syncWorkingEditorState"),
			settingsManager: { getShowTerminalProgress: () => false },
			session: { abortCompaction: vi.fn(), isStreaming: false },
			ui: {
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				terminal: { setProgress: vi.fn() },
			},
			workingIndicatorOptions: undefined,
			workingVisible: true,
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: AgentSessionEvent,
		) => Promise<void>;

		try {
			await handleEvent.call(fakeThis, {
				type: "compaction_start",
				reason: "manual",
				sourceHint: {
					type: "openai_remote",
					provider: "openai",
					model: "gpt-4.1-mini",
					endpoint: "https://api.openai.com/v1/responses/compact",
				},
			});

			const renderedLoader = addedChildren[0]?.render(120).join("\n") ?? "";
			expect(renderedLoader).toContain(
				"Compacting context via OpenAI remote endpoint (openai/gpt-4.1-mini, https://api.openai.com/v1/responses/compact)...",
			);
			expect(editor.working).toBe(true);
			const renderCountAfterStart = fakeThis.ui.requestRender.mock.calls.length;

			await vi.advanceTimersByTimeAsync(1_000);

			expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(renderCountAfterStart);

			await handleEvent.call(fakeThis, {
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: true,
				willRetry: false,
			});
			expect(editor.working).toBe(false);
		} finally {
			addedChildren[0]?.stop?.();
			vi.useRealTimers();
		}
	});

	test("renders one enriched compaction summary before kept messages after compaction", async () => {
		const entries: SessionEntry[] = [
			userEntry("old-user", null, "compacted-away user"),
			assistantEntry("old-assistant", "old-user", "compacted-away assistant"),
			userEntry("kept-user", "old-assistant", "kept user"),
			assistantEntry("kept-assistant", "kept-user", "kept assistant"),
			{
				type: "compaction",
				id: "compaction",
				parentId: "kept-assistant",
				timestamp: "2026-08-08T00:00:00.000Z",
				summary: "generated summary",
				firstKeptEntryId: "kept-user",
				tokensBefore: 123,
				durationMs: 4567,
			},
			userEntry("post-user", "compaction", "post-compaction user"),
			assistantEntry("post-assistant", "post-user", "post-compaction assistant"),
		];
		const fakeThis = {
			isInitialized: true,
			isViewingAgentSession: () => false,
			handleHiddenMainSessionDisplayEvent: Reflect.get(
				InteractiveMode.prototype,
				"handleHiddenMainSessionDisplayEvent",
			),
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: new Container(),
			sessionManager: {
				buildContextEntries: () => buildContextEntries(entries),
				getCwd: () => "/repo",
			},
			rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			rebuildChatAfterCompaction: Reflect.get(InteractiveMode.prototype, "rebuildChatAfterCompaction"),
			renderSessionEntries: Reflect.get(InteractiveMode.prototype, "renderSessionEntries"),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
			clearPendingToolComponents: Reflect.get(InteractiveMode.prototype, "clearPendingToolComponents"),
			pendingTools: new Map(),
			completedToolTimings: new Map(),
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
			getUserMessageText: Reflect.get(InteractiveMode.prototype, "getUserMessageText"),
			getMarkdownThemeWithSettings: Reflect.get(InteractiveMode.prototype, "getMarkdownThemeWithSettings"),
			getRegisteredToolDefinition: () => undefined,
			toolOutputExpanded: true,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			setPromptActivity: vi.fn(),
			settingsManager: {
				getShowTerminalProgress: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 80,
				getCodeBlockIndent: () => 0,
			},
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
							estimatedTokensAfter?: number;
							keptFromPreviousContextTokens?: number;
							compactedResultTokens?: number;
							source?: {
								type: "openai_remote";
								provider: string;
								model: string;
								endpoint: string;
							};
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
				summary: "generated summary",
				durationMs: 4567,
				estimatedTokensAfter: 89,
				keptFromPreviousContextTokens: 67,
				compactedResultTokens: 22,
				source: {
					type: "openai_remote",
					provider: "openai",
					model: "gpt-4.1-mini",
					endpoint: "https://api.openai.com/v1/responses/compact",
				},
			},
			aborted: false,
			willRetry: false,
		});

		const output = fakeThis.chatContainer
			.render(220)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "")
			.trim();
		const summaryIndex = output.indexOf("generated summary");
		const keptIndex = output.indexOf("kept user");
		const postIndex = output.indexOf("post-compaction user");

		expect(output.match(/\[compaction\]/g)).toHaveLength(1);
		expect(output.match(/generated summary/g)).toHaveLength(1);
		expect(output).toContain("Compacted from 123 to 89 tokens; kept 67 tokens; remote result 22 tokens in 4.6s");
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(summaryIndex).toBeLessThan(keptIndex);
		expect(keptIndex).toBeLessThan(postIndex);
		expect(output).not.toContain("compacted-away");
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			"Compaction completed via OpenAI remote endpoint (openai/gpt-4.1-mini, https://api.openai.com/v1/responses/compact)",
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("flushCompactionQueue delivers queued messages even when a turn resumed after compaction", async () => {
		// Reproduces the race: compaction ends, the mailbox drain resumes a streaming
		// turn (e.g. wait_agents) before the deferred flush runs. The flush must queue
		// via streamingBehavior instead of hitting the "already processing" guard.
		const delivered: Array<{ text: string; behavior?: "steer" | "followUp" }> = [];
		const fakeSession = {
			isStreaming: true,
			clearQueue: vi.fn(),
			steer: vi.fn().mockResolvedValue(undefined),
			followUp: vi.fn().mockResolvedValue(undefined),
			prompt: vi.fn(async (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
				if (fakeSession.isStreaming && !options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				delivered.push({ text, behavior: options?.streamingBehavior });
			}),
		};
		const fakeThis = {
			compactionQueuedMessages: [{ text: "after pushing, review the PR", mode: "steer" as const }],
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			isExtensionCommand: () => false,
			deliverCompactionMessage: Reflect.get(InteractiveMode.prototype, "deliverCompactionMessage"),
			session: fakeSession,
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });
		// The first prompt is sent fire-and-forget; let its rejection handler (if any) run.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(delivered).toEqual([{ text: "after pushing, review the PR", behavior: "steer" }]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
	});

	test("flushCompactionQueue queues followUp messages with followUp behavior", async () => {
		const delivered: Array<{ text: string; behavior?: "steer" | "followUp" }> = [];
		const fakeSession = {
			isStreaming: true,
			clearQueue: vi.fn(),
			steer: vi.fn().mockResolvedValue(undefined),
			followUp: vi.fn().mockResolvedValue(undefined),
			prompt: vi.fn(async (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
				if (fakeSession.isStreaming && !options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				delivered.push({ text, behavior: options?.streamingBehavior });
			}),
		};
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "first follow-up", mode: "followUp" as const },
				{ text: "second follow-up", mode: "followUp" as const },
			],
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			isExtensionCommand: () => false,
			deliverCompactionMessage: Reflect.get(InteractiveMode.prototype, "deliverCompactionMessage"),
			session: fakeSession,
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(delivered).toEqual([{ text: "first follow-up", behavior: "followUp" }]);
		expect(fakeSession.followUp).toHaveBeenCalledWith("second follow-up");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("formats compaction timeout failures with actionable context", () => {
		expect(
			formatCompactionFailureMessage({
				errorMessage: "Context overflow recovery failed: Turn prefix summarization failed: Request timed out.",
				reason: "overflow",
				sourceHint: { type: "local", provider: "ollama", model: "qwen3:4b-instruct-128k" },
			}),
		).toBe(
			[
				"Context overflow recovery failed after compaction timeout.",
				"Model: ollama/qwen3:4b-instruct-128k.",
				"The compaction request did not finish before the timeout.",
				"No compaction was saved; the previous context is still too large.",
				"Original error: Turn prefix summarization failed: Request timed out.",
			].join("\n"),
		);

		expect(
			formatCompactionFailureMessage({
				errorMessage: "Compaction failed: Turn prefix summarization failed: Request timed out.",
				reason: "manual",
				sourceHint: { type: "local", provider: "ollama", model: "qwen3:4b-instruct-128k" },
			}),
		).toContain("Original error: Turn prefix summarization failed: Request timed out.");
	});

	test("logs local compaction source when no remote endpoint was used", async () => {
		const fakeThis = {
			isInitialized: true,
			isViewingAgentSession: () => false,
			handleHiddenMainSessionDisplayEvent: Reflect.get(
				InteractiveMode.prototype,
				"handleHiddenMainSessionDisplayEvent",
			),
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			rebuildChatAfterCompaction: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			setPromptActivity: vi.fn(),
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
				source: { type: "local", provider: "anthropic", model: "claude-sonnet-4-5" },
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Compaction completed locally (anthropic/claude-sonnet-4-5)");
	});
});
