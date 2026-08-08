import { Container, type EditorComponent, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type {
	CompactionEntry,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "../src/core/session-manager.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class TestEditor implements EditorComponent {
	readonly addToHistory = vi.fn();
	private text = "";

	render(): string[] {
		return [this.text];
	}

	invalidate(): void {}
	handleInput(): void {}
	getText(): string {
		return this.text;
	}
	setText(text: string): void {
		this.text = text;
	}
	setScreenOrigin(): void {}
	clearScreenOrigin(): void {}
}

function userMessage(id: string, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-08T00:00:00.000Z",
		message: { role: "user", content, timestamp: 0 },
	};
}

function compaction(id: string, parentId: string, summary: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-08-08T00:01:00.000Z",
		summary,
		firstKeptEntryId: parentId,
		tokensBefore: 12_345,
	};
}

function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
	const nodes = entries.map((entry): SessionTreeNode => ({ entry, children: [] }));
	const nodesById = new Map(nodes.map((node) => [node.entry.id, node]));
	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		const parent = node.entry.parentId === null ? undefined : nodesById.get(node.entry.parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	return roots;
}

type SubmitContext = {
	addSubmittedTextToHistory(this: SubmitContext, text: string): void;
	chatContainer: Container;
	closeResponseCompleteNotification(): void;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: TestEditor;
	flushPendingBashComponents(): void;
	isBashMode: boolean;
	pendingCompactionSummaryEditId: string | undefined;
	pendingUserInputs: string[];
	renderInitialMessages(): void;
	runtimeHost: { session: TestSession };
	showError(message: string): void;
	showSettingsSelector(): void;
	showStatus(message: string): void;
	submitPendingCompactionSummaryEdit(this: SubmitContext, summary: string): boolean;
	submitSelectedAgentSteering(this: SubmitContext, message: string, submittedText?: string): Promise<boolean>;
	ui: { requestRender(): void; terminal: { rows: number } };
	updateEditorBorderColor(): void;
	updatePendingMessagesDisplay(): void;
};

type TestSession = {
	abortBranchSummary(): void;
	continue(): Promise<void>;
	isBashRunning: boolean;
	isCompacting: boolean;
	isStreaming: boolean;
	navigateTree: ReturnType<typeof vi.fn>;
	prompt(): Promise<void>;
	promptTemplates: [];
	sessionManager: {
		appendLabelChange(entryId: string, label: string | undefined): void;
		getEntry(entryId: string): SessionEntry | undefined;
		getLeafId(): string;
		getTree(): SessionTreeNode[];
	};
	settingsManager: {
		getBranchSummarySkipPrompt(): boolean;
		getTreeFilterMode(): "user-only";
	};
	updateCompactionSummary: ReturnType<typeof vi.fn>;
};

type SelectorFactory = (done: () => void) => {
	component: TreeSelectorComponent;
	focus: TreeSelectorComponent;
};

type TreeContext = SubmitContext & {
	flushCompactionQueue(): Promise<void>;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showSelector(factory: SelectorFactory): void;
};

type InteractiveModePrivate = {
	addSubmittedTextToHistory(this: SubmitContext, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
	showTreeSelector(this: TreeContext): void;
	submitPendingCompactionSummaryEdit(this: SubmitContext, summary: string): boolean;
	submitSelectedAgentSteering(this: SubmitContext, message: string, submittedText?: string): Promise<boolean>;
};

type EditHarness = {
	compacted: CompactionEntry;
	context: TreeContext;
	editor: TestEditor;
	getSelector(): TreeSelectorComponent | undefined;
	session: TestSession;
};

const interactiveMode = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createEditHarness(): EditHarness {
	const root = userMessage("user-1", "retained prompt");
	const compacted = compaction("compaction-1", root.id, "generated summary");
	const entries = new Map<string, SessionEntry>([
		[root.id, root],
		[compacted.id, compacted],
	]);
	const editor = new TestEditor();
	let selector: TreeSelectorComponent | undefined;
	const session: TestSession = {
		abortBranchSummary: vi.fn(),
		continue: vi.fn(async () => {}),
		isBashRunning: false,
		isCompacting: false,
		isStreaming: false,
		navigateTree: vi.fn(),
		prompt: vi.fn(async () => {}),
		promptTemplates: [],
		sessionManager: {
			appendLabelChange: vi.fn(),
			getEntry: (entryId) => entries.get(entryId),
			getLeafId: () => compacted.id,
			getTree: () => buildTree([...entries.values()]),
		},
		settingsManager: {
			getBranchSummarySkipPrompt: () => false,
			getTreeFilterMode: () => "user-only",
		},
		updateCompactionSummary: vi.fn(),
	};
	const context = Object.assign(Object.create(InteractiveMode.prototype) as TreeContext, {
		addSubmittedTextToHistory: interactiveMode.addSubmittedTextToHistory,
		chatContainer: new Container(),
		closeResponseCompleteNotification: vi.fn(),
		defaultEditor: {},
		editor,
		flushCompactionQueue: vi.fn(async () => {}),
		flushPendingBashComponents: vi.fn(),
		isBashMode: false,
		pendingCompactionSummaryEditId: undefined,
		pendingUserInputs: [],
		renderInitialMessages: vi.fn(),
		runtimeHost: { session },
		showError: vi.fn(),
		showExtensionSelector: vi.fn(async () => "Summarize"),
		showSelector: (factory: SelectorFactory) => {
			selector = factory(() => {}).component;
		},
		showSettingsSelector: vi.fn(),
		showStatus: vi.fn(),
		submitPendingCompactionSummaryEdit: interactiveMode.submitPendingCompactionSummaryEdit,
		submitSelectedAgentSteering: interactiveMode.submitSelectedAgentSteering,
		ui: { requestRender: vi.fn(), terminal: { rows: 24 } },
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	});
	return { compacted, context, editor, getSelector: () => selector, session };
}

describe("InteractiveMode compaction summary editing", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("loads the current compaction summary into the message editor and saves the edit", async () => {
		const { compacted, context, editor, getSelector, session } = createEditHarness();

		interactiveMode.showTreeSelector.call(context);
		const onSelect = getSelector()?.getTreeList().onSelect;
		if (!onSelect) throw new Error("Tree selector did not expose a selection callback");
		await onSelect(compacted.id);

		expect(editor.getText()).toBe("generated summary");
		expect(context.pendingCompactionSummaryEditId).toBe(compacted.id);
		expect(session.navigateTree).not.toHaveBeenCalled();
		expect(context.showExtensionSelector).not.toHaveBeenCalled();

		interactiveMode.setupEditorSubmitHandler.call(context);
		await context.defaultEditor.onSubmit?.("  edited summary  ");

		expect(session.updateCompactionSummary).toHaveBeenCalledWith(compacted.id, "edited summary");
		expect(context.pendingCompactionSummaryEditId).toBeUndefined();
		expect(editor.getText()).toBe("");
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.renderInitialMessages).toHaveBeenCalledTimes(1);
		expect(context.showStatus).toHaveBeenLastCalledWith("Compaction summary updated");
	});

	it("keeps slash commands out of the compaction summary edit", async () => {
		const { compacted, context, session } = createEditHarness();
		context.pendingCompactionSummaryEditId = compacted.id;
		interactiveMode.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/debug");

		expect(session.updateCompactionSummary).not.toHaveBeenCalled();
		expect(context.pendingCompactionSummaryEditId).toBe(compacted.id);
		expect(context.pendingUserInputs).toEqual(["/debug"]);
	});
});
