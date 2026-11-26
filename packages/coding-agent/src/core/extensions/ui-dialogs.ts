/** Options for extension UI dialogs. */
export interface ExtensionUIDialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	timeout?: number;
	/** Mask entered characters in interactive text input. */
	secret?: boolean;
}

/** One ask_questions question as shown to a UI. */
export interface ExtensionUIQuestion {
	question: string;
	header?: string;
	/** Omitted for a free-text question. The UI also offers a free-text "Other" answer. */
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

/** Answers keyed by question text; multi-select answers are comma-joined labels. */
export interface ExtensionUIQuestionsResult {
	answers: Record<string, string>;
	cancelled: boolean;
}
