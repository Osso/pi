import { readFileSync } from "node:fs";
import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createAssistantMessage,
	createFakeInteractiveModeThis,
	handleEvent,
} from "./fixtures/interactive-mode-streaming.ts";

const narrationFixture = JSON.parse(
	readFileSync(new URL("./fixtures/anthropic-narration.json", import.meta.url), "utf8"),
) as { content: ThinkingContent[] };

describe("InteractiveMode narration streaming", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test.each([true, false])("renders signed narration before message completion (hide=%s)", async (hide) => {
		vi.useFakeTimers();
		const mode = createFakeInteractiveModeThis();
		mode.hideThinkingBlock = hide;
		const [ordinaryThinking, narration] = structuredClone(narrationFixture.content);
		const partial: AssistantMessage = {
			...createAssistantMessage(""),
			content: [ordinaryThinking, { type: "thinking", thinking: narration.thinking }],
		};
		const frames: string[][] = [];
		mode.transcriptTailRegion.requestRender = () => {
			frames.push(mode.transcriptTailContainer.render(400));
			return true;
		};
		await handleEvent.call(mode, { type: "message_start", message: partial });
		await handleEvent.call(mode, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 1,
				delta: narration.thinking,
				partial,
			},
		});
		await vi.advanceTimersByTimeAsync(250);
		if (hide) {
			expect(frames).toHaveLength(1);
			expect(frames.at(-1)?.map(stripAnsi).join("\n")).not.toContain(narration.thinking.trim());
		}

		const completed: AssistantMessage = {
			...partial,
			content: [ordinaryThinking, narration],
		};
		const original = structuredClone(completed);
		let releaseStream: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		let streamCompleted = false;
		const stream = (async () => {
			await handleEvent.call(mode, {
				type: "message_update",
				message: completed,
				assistantMessageEvent: {
					type: "thinking_end",
					contentIndex: 1,
					content: narration.thinking,
					partial: completed,
				},
			});
			await released;
			await handleEvent.call(mode, {
				type: "message_end",
				message: completed,
			});
			streamCompleted = true;
		})();
		try {
			await vi.advanceTimersByTimeAsync(250);
			expect(streamCompleted).toBe(false);
			expect(mode.chatContainer.children).toHaveLength(0);
			expect(frames.at(-1)?.map(stripAnsi).join("\n")).toContain(narration.thinking.trim());
			const expected = new AssistantMessageComponent(
				{
					...completed,
					content: [ordinaryThinking, { type: "text", text: narration.thinking }],
				},
				hide,
				getMarkdownTheme(),
			);
			expect(frames.at(-1)).toEqual(expected.render(400));
			expect(completed).toEqual(original);
			expect(partial.content[1]).not.toHaveProperty("thinkingSignature");
		} finally {
			if (!releaseStream) throw new Error("Streaming release was not initialized");
			releaseStream();
			await stream;
		}
	});

	test.each([true, false])("does not redraw ordinary thinking_end (hide=%s)", async (hide) => {
		vi.useFakeTimers();
		const mode = createFakeInteractiveModeThis();
		mode.hideThinkingBlock = hide;
		const [ordinaryThinking, narration] = structuredClone(narrationFixture.content);
		const message: AssistantMessage = {
			...createAssistantMessage(""),
			content: [narration, ordinaryThinking],
		};
		await handleEvent.call(mode, { type: "message_start", message });
		vi.mocked(mode.ui.requestRender).mockClear();
		await handleEvent.call(mode, {
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 1,
				content: ordinaryThinking.thinking,
				partial: message,
			},
		});
		await vi.advanceTimersByTimeAsync(250);
		expect(mode.ui.requestRender).not.toHaveBeenCalled();
		if (hide) {
			expect(mode.transcriptTailContainer.render(400).map(stripAnsi).join("\n")).not.toContain(
				ordinaryThinking.thinking.trim(),
			);
		}
	});
});
