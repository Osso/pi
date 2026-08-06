import type { EditorComponent, LoaderIndicatorOptions, RootLayoutRect } from "@earendil-works/pi-tui";

type WorkingEditorComponent = EditorComponent & {
	setWorking?: (working: boolean) => void;
	setWorkingIndicator?: (options?: LoaderIndicatorOptions) => void;
	setScreenOrigin?: (row: number, col: number) => void;
	clearScreenOrigin?: () => void;
};

function asWorkingEditor(editor: EditorComponent): WorkingEditorComponent {
	return editor;
}

export function syncWorkingEditor(
	editor: EditorComponent,
	working: boolean,
	indicator?: LoaderIndicatorOptions,
): void {
	const workingEditor = asWorkingEditor(editor);
	workingEditor.setWorkingIndicator?.(indicator);
	workingEditor.setWorking?.(working);
}

export function positionWorkingEditor(editor: EditorComponent, rect: Pick<RootLayoutRect, "row" | "col">): void {
	asWorkingEditor(editor).setScreenOrigin?.(rect.row, rect.col);
}

export function clearWorkingEditor(editor: EditorComponent): void {
	const workingEditor = asWorkingEditor(editor);
	workingEditor.setWorking?.(false);
	workingEditor.clearScreenOrigin?.();
}
