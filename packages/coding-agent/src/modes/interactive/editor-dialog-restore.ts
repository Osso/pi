import type { Container, TUI } from "@earendil-works/pi-tui";

export function captureEditorDialogRestore(container: Container, ui: TUI): () => void {
	const children = [...container.children];
	const focus = ui.getFocusedComponent();
	return () => {
		container.clear();
		for (const child of children) container.addChild(child);
		ui.setFocus(focus);
		ui.requestRender();
	};
}
