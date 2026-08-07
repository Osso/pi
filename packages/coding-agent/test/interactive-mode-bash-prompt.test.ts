import { Container, type EditorComponent, type LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class WorkingEditor implements EditorComponent {
	working = false;
	indicator: LoaderIndicatorOptions | undefined;

	render(): string[] {
		return [this.working ? "working" : "idle"];
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
	setWorkingIndicator(indicator?: LoaderIndicatorOptions): void {
		this.indicator = indicator;
	}
	setScreenOrigin(): void {}
	clearScreenOrigin(): void {}
}

type BashResult = {
	cancelled: boolean;
	exitCode: number;
	output: string;
	truncated: boolean;
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

type BashContext = {
	bashComponent: undefined;
	chatContainer: Container;
	editor: WorkingEditor;
	editorContainer: { children: EditorComponent[] };
	footer: { invalidate(): void };
	isSelectedChildWorking(): boolean;
	isViewingAgentSession(): boolean;
	pendingBashComponents: unknown[];
	pendingMessagesContainer: Container;
	promptActivitySources: Set<string>;
	runtimeHost: {
		session: {
			executeBash: ReturnType<typeof vi.fn>;
			extensionRunner: { emitUserBash: ReturnType<typeof vi.fn> };
			isStreaming: boolean;
			sessionManager: { getCwd(): string };
		};
	};
	ui: { requestComponentRender(component: unknown): boolean; requestRender(): void };
	workingIndicatorOptions: LoaderIndicatorOptions | undefined;
	workingVisible: boolean;
};

type HandleBashCommand = (this: BashContext, command: string, excludeFromContext?: boolean) => Promise<void>;

const handleBashCommand = Reflect.get(InteractiveMode.prototype, "handleBashCommand") as HandleBashCommand;

describe("InteractiveMode bash prompt activity", () => {
	it("animates the prompt only while a local bash command is running", async () => {
		initTheme("dark");
		const deferred = createDeferred<BashResult>();
		const editor = new WorkingEditor();
		const executeBash = vi.fn(() => deferred.promise);
		const context = Object.assign(Object.create(InteractiveMode.prototype) as BashContext, {
			bashComponent: undefined,
			chatContainer: new Container(),
			editor,
			editorContainer: { children: [editor] },
			footer: { invalidate: vi.fn() },
			isSelectedChildWorking: () => false,
			isViewingAgentSession: () => false,
			pendingBashComponents: [],
			pendingMessagesContainer: new Container(),
			promptActivitySources: new Set<string>(),
			runtimeHost: {
				session: {
					executeBash,
					extensionRunner: { emitUserBash: vi.fn(async () => undefined) },
					isStreaming: false,
					sessionManager: { getCwd: () => process.cwd() },
				},
			},
			ui: {
				requestComponentRender: () => false,
				requestRender: vi.fn(),
			},
			workingIndicatorOptions: { frames: ["a", "b"], intervalMs: 250 },
			workingVisible: true,
		});

		const command = handleBashCommand.call(context, "sleep 1");
		await Promise.resolve();
		await Promise.resolve();

		expect(executeBash).toHaveBeenCalledTimes(1);
		expect(editor.working).toBe(true);
		expect(editor.indicator).toEqual(context.workingIndicatorOptions);

		deferred.resolve({ cancelled: false, exitCode: 0, output: "", truncated: false });
		await command;

		expect(editor.working).toBe(false);
	});
});
