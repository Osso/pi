import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { buildContextEntries, type SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

function createCompactedEntries(): SessionEntry[] {
	return [
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
}

describe("InteractiveMode compaction transcript rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders one enriched compaction summary before kept messages after compaction", async () => {
		const entries = createCompactedEntries();
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
			event: Extract<AgentSessionEvent, { type: "compaction_end" }>,
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "generated summary",
				firstKeptEntryId: "kept-user",
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

		const output = stripAnsi(fakeThis.chatContainer.render(220).join("\n")).trim();
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
});
