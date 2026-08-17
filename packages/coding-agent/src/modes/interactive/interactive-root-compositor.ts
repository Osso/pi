import { type Component, RootCompositor, type RootFlowLayout, type RootLayoutRect } from "@earendil-works/pi-tui";

export type InteractiveRootFlowLayout = RootFlowLayout;

export interface InteractiveRootCompositorOptions {
	getHeight: () => number;
	header: Component;
	loadedResources: Component;
	chat: Component;
	onChatLayout: (rect: RootLayoutRect) => void;
	transcriptTail: Component;
	pendingMessages: Component;
	onTranscriptTailLayout: (layout: InteractiveRootFlowLayout) => void;
	status: Component;
	widgetAbove: Component;
	editor: Component;
	widgetBelow: Component;
	footer: Component;
	onStatusLayout: (rect: RootLayoutRect) => void;
	onEditorLayout: (rect: RootLayoutRect) => void;
}

export function createInteractiveRootCompositor(options: InteractiveRootCompositorOptions): RootCompositor {
	return new RootCompositor({
		getHeight: options.getHeight,
		flow: [
			{ component: options.header },
			{ component: options.loadedResources },
			{ component: options.chat, onLayout: options.onChatLayout },
			{ component: options.transcriptTail, onFlowLayout: options.onTranscriptTailLayout },
			{ component: options.pendingMessages },
		],
		bottom: [
			{ component: options.status, onLayout: options.onStatusLayout },
			{ component: options.widgetAbove },
			{ component: options.editor, onLayout: options.onEditorLayout },
			{ component: options.widgetBelow },
			{ component: options.footer },
		],
	});
}
