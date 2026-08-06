import { type Component, RootCompositor, type RootLayoutRect } from "@earendil-works/pi-tui";

export interface InteractiveRootCompositorOptions {
	getHeight: () => number;
	header: Component;
	loadedResources: Component;
	chat: Component;
	pendingMessages: Component;
	status: Component;
	widgetAbove: Component;
	editor: Component;
	widgetBelow: Component;
	footer: Component;
	onEditorLayout: (rect: RootLayoutRect) => void;
}

export function createInteractiveRootCompositor(options: InteractiveRootCompositorOptions): RootCompositor {
	return new RootCompositor({
		getHeight: options.getHeight,
		flow: [
			{ component: options.header },
			{ component: options.loadedResources },
			{ component: options.chat },
			{ component: options.pendingMessages },
		],
		bottom: [
			{ component: options.status },
			{ component: options.widgetAbove },
			{ component: options.editor, onLayout: options.onEditorLayout },
			{ component: options.widgetBelow },
			{ component: options.footer },
		],
	});
}
