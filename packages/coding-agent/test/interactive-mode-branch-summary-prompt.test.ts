import { Container, type EditorComponent, type LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class WorkingEditor implements EditorComponent {
	working = false;
	indicator: LoaderIndicatorOptions | undefined;
	private text = "";

	render(): string[] {
		return [this.working ? "working" : "idle"];
	}
	invalidate(): void {}
	handleInput(): void {}
	getText(): string {
		return this.text;
	}
	setText(text: string): void {
		this.text = text;
	}
	setWorking(working: boolean): void {
		this.working = working;
	}
	setWorkingIndicator(indicator?: LoaderIndicatorOptions): void {
		this.indicator = indicator;
	}
	setScreenOrigin(): void {}
	clearScreenOrigin(): void {}
}

type NavigationResult = {
	aborted: boolean;
	cancelled: boolean;
	editorText: string | undefined;
};

type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
};

function createDeferred<T>(): Deferred<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => {
			if (!resolvePromise) throw new Error("Deferred promise was not initialized");
			resolvePromise(value);
		},
	};
}

function userEntry(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-06T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

function createTree(): SessionTreeNode[] {
	const root = userEntry("root", null, "root prompt");
	const leaf = userEntry("leaf", root.id, "leaf prompt");
	return [{ entry: root, children: [{ entry: leaf, children: [] }] }];
}

type SelectorFactory = (done: () => void) => {
	component: TreeSelectorComponent;
	focus: TreeSelectorComponent;
};

type BranchContext = {
	chatContainer: Container;
	defaultEditor: { onEscape?: () => void };
	editor: WorkingEditor;
	editorContainer: { children: EditorComponent[] };
	flushCompactionQueue(): Promise<void>;
	isSelectedChildWorking(): boolean;
	isViewingAgentSession(): boolean;
	promptActivitySources: Set<string>;
	renderInitialMessages(): void;
	runtimeHost: {
		session: {
			abortBranchSummary(): void;
			isStreaming: boolean;
			navigateTree: ReturnType<typeof vi.fn>;
			sessionManager: {
				appendLabelChange(entryId: string, label: string | undefined): void;
				getLeafId(): string;
				getTree(): SessionTreeNode[];
			};
			settingsManager: {
				getBranchSummarySkipPrompt(): boolean;
				getTreeFilterMode(): "default";
			};
		};
	};
	showError(message: string): void;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showSelector(factory: SelectorFactory): void;
	showStatus(message: string): void;
	statusContainer: Container;
	ui: { requestRender(): void; terminal: { rows: number } };
	workingIndicatorOptions: LoaderIndicatorOptions | undefined;
	workingVisible: boolean;
};

type ShowTreeSelector = (this: BranchContext, initialSelectedId?: string) => void;

type AsyncSelect = (entryId: string) => Promise<void>;

const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as ShowTreeSelector;

describe("InteractiveMode branch-summary prompt activity", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses the prompt spinner and a static status label while summarizing", async () => {
		initTheme("dark");
		vi.useFakeTimers();
		const navigation = createDeferred<NavigationResult>();
		const navigateTree = vi.fn(() => navigation.promise);
		const editor = new WorkingEditor();
		const requestRender = vi.fn();
		let selector: TreeSelectorComponent | undefined;
		const context = Object.assign(Object.create(InteractiveMode.prototype) as BranchContext, {
			chatContainer: new Container(),
			defaultEditor: {},
			editor,
			editorContainer: { children: [editor] },
			flushCompactionQueue: vi.fn(async () => {}),
			isSelectedChildWorking: () => false,
			isViewingAgentSession: () => false,
			promptActivitySources: new Set<string>(),
			renderInitialMessages: vi.fn(),
			runtimeHost: {
				session: {
					abortBranchSummary: vi.fn(),
					isStreaming: false,
					navigateTree,
					sessionManager: {
						appendLabelChange: vi.fn(),
						getLeafId: () => "leaf",
						getTree: createTree,
					},
					settingsManager: {
						getBranchSummarySkipPrompt: () => false,
						getTreeFilterMode: () => "default" as const,
					},
				},
			},
			showError: vi.fn(),
			showExtensionSelector: vi.fn(async () => "Summarize"),
			showSelector: (factory: SelectorFactory) => {
				selector = factory(() => {}).component;
			},
			showStatus: vi.fn(),
			statusContainer: new Container(),
			ui: { requestRender, terminal: { rows: 24 } },
			workingIndicatorOptions: { frames: ["a", "b"], intervalMs: 250 },
			workingVisible: true,
		});

		showTreeSelector.call(context);
		const onSelect = selector?.getTreeList().onSelect as AsyncSelect | undefined;
		if (!onSelect) throw new Error("Tree selector did not expose a selection callback");
		const selection = onSelect("root");
		await Promise.resolve();
		await Promise.resolve();

		expect(navigateTree).toHaveBeenCalledWith("root", {
			summarize: true,
			customInstructions: undefined,
		});
		expect(editor.working).toBe(true);
		expect(editor.indicator).toEqual(context.workingIndicatorOptions);
		const renderCountAfterStart = requestRender.mock.calls.length;

		await vi.advanceTimersByTimeAsync(1_000);

		expect(requestRender).toHaveBeenCalledTimes(renderCountAfterStart);

		navigation.resolve({ aborted: false, cancelled: false, editorText: undefined });
		await selection;

		expect(editor.working).toBe(false);
	});
});
