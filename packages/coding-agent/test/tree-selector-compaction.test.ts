import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	CompactionEntry,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function assistantMessage(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string, summary: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 12_345,
	};
}

function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
	const nodes = entries.map((entry): SessionTreeNode => ({ entry, children: [] }));
	const nodesById = new Map(nodes.map((node) => [node.entry.id, node]));
	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		const parent = node.entry.parentId === null ? undefined : nodesById.get(node.entry.parentId);
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

describe("TreeSelectorComponent compaction view", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("shows the generated compaction summary before retained active-context prompts", () => {
		const entries: SessionEntry[] = [
			userMessage("user-old", null, "compacted-away prompt"),
			assistantMessage("assistant-old", "user-old", "compacted-away response"),
			userMessage("user-kept", "assistant-old", "retained prompt"),
			assistantMessage("assistant-kept", "user-kept", "retained response"),
			compactionEntry("compaction-1", "assistant-kept", "user-kept", "generated compacted summary"),
			userMessage("user-later", "compaction-1", "later prompt"),
			assistantMessage("assistant-later", "user-later", "later response"),
		];
		const selector = new TreeSelectorComponent(
			buildTree(entries),
			"assistant-later",
			24,
			() => {},
			() => {},
			undefined,
			undefined,
			"user-only",
		);

		const plain = selector.getTreeList().render(200).map(stripVTControlCharacters).join("\n");
		const summaryIndex = plain.indexOf("generated compacted summary");
		const retainedIndex = plain.indexOf("retained prompt");
		const laterIndex = plain.indexOf("later prompt");

		expect(plain).not.toContain("compacted-away prompt");
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(summaryIndex).toBeLessThan(retainedIndex);
		expect(retainedIndex).toBeLessThan(laterIndex);
		expect(plain).toContain("(3/3) [user]");

		selector.handleInput("\x04");
		const fullTree = selector.getTreeList().render(200).map(stripVTControlCharacters).join("\n");
		expect(fullTree).toContain("compacted-away prompt");
	});
});
