import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.ts";
import type { CompactionResult } from "../src/core/compaction/compaction.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CompactCommandContext = {
	loadingAnimation: undefined;
	statusContainer: { clear: () => void };
	session: {
		subscribe: (listener: AgentSessionEventListener) => () => void;
		compact: () => Promise<CompactionResult>;
	};
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	handleCompactCommand(this: CompactCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

const savedCompaction: CompactionResult = {
	summary: "Earlier work summarized",
	firstKeptEntryId: "entry-1",
	tokensBefore: 1000,
};

function createContext(compactionEnd: AgentSessionEvent, error: Error) {
	let listener: AgentSessionEventListener | undefined;
	const showError = vi.fn();
	const context: CompactCommandContext = {
		loadingAnimation: undefined,
		statusContainer: { clear: vi.fn() },
		session: {
			subscribe: (next) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			compact: async () => {
				listener?.(compactionEnd);
				throw error;
			},
		},
		showError,
	};
	return { context, showError, hasListener: () => listener !== undefined };
}

describe("InteractiveMode /compact", () => {
	it("shows a resumed-turn error after the compaction was saved", async () => {
		const { context, showError, hasListener } = createContext(
			{ type: "compaction_end", reason: "manual", result: savedCompaction, aborted: false, willRetry: true },
			new Error("Main session thinking phase exceeded 15 minutes"),
		);

		await interactiveModePrototype.handleCompactCommand.call(context);

		expect(showError).toHaveBeenCalledExactlyOnceWith("Main session thinking phase exceeded 15 minutes");
		expect(hasListener()).toBe(false);
	});

	it("leaves compaction failures to the compaction_end renderer", async () => {
		const { context, showError } = createContext(
			{
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: "Compaction failed: provider unavailable",
			},
			new Error("provider unavailable"),
		);

		await interactiveModePrototype.handleCompactCommand.call(context);

		expect(showError).not.toHaveBeenCalled();
	});
});
