import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type LoaderIndicatorOptions, type MarkdownTheme, Text, type TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { AgentSnapshot } from "../../src/core/multi-agent-store.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme } from "../../src/modes/interactive/theme/theme.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type HandleEventThis = {
	chatContainer: Container;
	transcriptTailContainer: Container;
	transcriptTailRegion: { requestRender(): boolean; clear(): void };
	childActivityTimer: ReturnType<typeof setInterval> | undefined;
	compactionQueuedMessages: [];
	currentWorkingDefaultMessage: string;
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	footer: { invalidate(): void };
	getMarkdownThemeWithSettings(): MarkdownTheme;
	hiddenThinkingLabel: string;
	hideThinkingBlock: boolean;
	isInitialized: boolean;
	editor: Text;
	editorContainer: Container;
	loadingAnimation:
		| {
				setIndicator?(options?: LoaderIndicatorOptions): void;
				setMessage(message: string): void;
		  }
		| undefined;
	multiAgentStore:
		| {
				getAgent(agentId: string): Pick<AgentSnapshot, "currentActivity"> | undefined;
				getSelectedAgentId(): string | undefined;
		  }
		| undefined;
	pendingMessagesContainer: Container;
	pendingTools: Map<string, unknown>;
	promptActivitySources: Set<string>;
	runtimeHost: {
		session: {
			getFollowUpMessages(): string[];
			getSteeringMessages(): string[];
			isStreaming: boolean;
			retryAttempt: number;
			sessionManager: { getCwd(): string };
			settingsManager: {
				getHideToolOutput(): boolean;
				getImageWidthCells(): number;
				getShowImages(): boolean;
			};
		};
	};
	streamingComponent: unknown;
	streamingMessage: AssistantMessage | undefined;
	thinkingFollowsTool: boolean;
	thinkingStartedAt: number | undefined;
	toolOutputExpanded: boolean;
	workingIndicatorOptions: LoaderIndicatorOptions | undefined;
	workingLoaderView: "main" | "child" | undefined;
	workingMessage: string | undefined;
	workingVisible: boolean;
	ui: Pick<TUI, "requestComponentRender" | "requestRender">;
	getRegisteredToolDefinition(): undefined;
};

type HandleEvent = (this: HandleEventThis, event: AgentSessionEvent) => Promise<void>;

export const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function createFakeInteractiveModeThis(): HandleEventThis {
	const editor = new Text("", 0, 0);
	const editorContainer = new Container();
	const requestRender = vi.fn();
	editorContainer.addChild(editor);
	return Object.assign(Object.create(InteractiveMode.prototype) as HandleEventThis, {
		chatContainer: new Container(),
		transcriptTailContainer: new Container(),
		transcriptTailRegion: {
			requestRender: () => {
				requestRender();
				return false;
			},
			clear: vi.fn(),
		},
		childActivityTimer: undefined,
		compactionQueuedMessages: [],
		currentWorkingDefaultMessage: "Thinking...",
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map<string, string>(),
		executingToolStartedAt: new Map<string, number>(),
		completedToolTimings: new Map<string, { startedAt: number; finishedAt: number }>(),
		footer: { invalidate: vi.fn() },
		getMarkdownThemeWithSettings: getMarkdownTheme,
		hiddenThinkingLabel: "Thinking...",
		hideThinkingBlock: false,
		isInitialized: true,
		editor,
		editorContainer,
		loadingAnimation: undefined,
		multiAgentStore: undefined,
		pendingMessagesContainer: new Container(),
		pendingTools: new Map<string, unknown>(),
		promptActivitySources: new Set(),
		runtimeHost: {
			session: {
				getFollowUpMessages: () => [],
				getSteeringMessages: () => [],
				isStreaming: true,
				retryAttempt: 0,
				sessionManager: { getCwd: () => process.cwd() },
				settingsManager: {
					getHideToolOutput: () => false,
					getImageWidthCells: () => 40,
					getShowImages: () => false,
				},
			},
		},
		streamingComponent: undefined,
		streamingMessage: undefined,
		thinkingFollowsTool: false,
		thinkingStartedAt: undefined,
		toolOutputExpanded: false,
		workingIndicatorOptions: undefined,
		workingLoaderView: undefined,
		workingMessage: undefined,
		workingVisible: true,
		ui: {
			requestRender,
			requestComponentRender: () => {
				requestRender();
				return false;
			},
		},
		getRegisteredToolDefinition: () => undefined,
	});
}
