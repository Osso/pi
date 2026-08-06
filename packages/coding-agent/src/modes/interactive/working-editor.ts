import {
	type EditorComponent,
	type LoaderIndicatorOptions,
	type RootLayoutRect,
	visibleWidth,
} from "@earendil-works/pi-tui";

type WorkingEditorComponent = EditorComponent & {
	setWorking: (working: boolean) => void;
	setWorkingIndicator: (options?: LoaderIndicatorOptions) => void;
	setScreenOrigin: (row: number, col: number) => void;
	clearScreenOrigin: () => void;
};

type PartialWorkingEditorComponent = EditorComponent & Partial<WorkingEditorComponent>;

function asPartialWorkingEditor(editor: EditorComponent): PartialWorkingEditorComponent {
	return editor;
}

function hasWorkingPromptMethods(editor: EditorComponent): editor is WorkingEditorComponent {
	const candidate = asPartialWorkingEditor(editor);
	const requiredMethods = [
		candidate.setWorking,
		candidate.setWorkingIndicator,
		candidate.setScreenOrigin,
		candidate.clearScreenOrigin,
	];
	return requiredMethods.every((method) => typeof method === "function");
}

function workingIndicatorFitsPrompt(indicator?: LoaderIndicatorOptions): boolean {
	const frames = indicator?.frames;
	if (frames === undefined || frames.length === 0) return true;
	return frames.every((frame) => visibleWidth(frame) === 1);
}

export function supportsWorkingPromptAnimation(
	editor: EditorComponent,
	indicator?: LoaderIndicatorOptions,
): editor is WorkingEditorComponent {
	return hasWorkingPromptMethods(editor) && workingIndicatorFitsPrompt(indicator);
}

export function syncWorkingEditor(editor: EditorComponent, working: boolean, indicator?: LoaderIndicatorOptions): void {
	const workingEditor = asPartialWorkingEditor(editor);
	if (hasWorkingPromptMethods(editor) && !workingIndicatorFitsPrompt(indicator)) {
		workingEditor.setWorking?.(false);
		return;
	}
	workingEditor.setWorkingIndicator?.(indicator);
	workingEditor.setWorking?.(working);
}

export function positionWorkingEditor(editor: EditorComponent, rect: Pick<RootLayoutRect, "row" | "col">): void {
	asPartialWorkingEditor(editor).setScreenOrigin?.(rect.row, rect.col);
}

export function clearWorkingEditorPosition(editor: EditorComponent): void {
	asPartialWorkingEditor(editor).clearScreenOrigin?.();
}

export function clearWorkingEditor(editor: EditorComponent): void {
	const workingEditor = asPartialWorkingEditor(editor);
	workingEditor.setWorking?.(false);
	workingEditor.clearScreenOrigin?.();
}
