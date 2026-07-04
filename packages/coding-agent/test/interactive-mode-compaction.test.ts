import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	formatCompactionFailureMessage,
	formatCompactionStartLabel,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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

	test("shows remote source in the in-progress compaction loader", async () => {
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
				sourceHint: {
					type: "openai_remote";
					provider: string;
					model: string;
					endpoint: string;
				};
			},
		) => Promise<void>;

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
				summary: "summary",
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

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
				durationMs: 4567,
				tokensAfter: 89,
				keptFromPreviousContextTokens: 67,
				compactedResultTokens: 22,
			}),
		);
		expect(fakeThis.showStatus).toHaveBeenCalledWith(
			"Compaction completed via OpenAI remote endpoint (openai/gpt-4.1-mini, https://api.openai.com/v1/responses/compact)",
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("flushCompactionQueue delivers queued messages even when a turn resumed after compaction", async () => {
		// Reproduces the race: compaction ends, the mailbox drain resumes a streaming
		// turn (e.g. wait_agent) before the deferred flush runs. The flush must queue
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
				source: { type: "local", provider: "anthropic", model: "claude-sonnet-4-5" },
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Compaction completed locally (anthropic/claude-sonnet-4-5)");
	});
});
