function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The editor drops the promises returned by submit and keybinding handlers, so a rejection would end
 * the process as an unhandled rejection. Report it in the chat instead.
 */
export function reportAsyncFailure(task: Promise<unknown>, showError: (message: string) => void): Promise<void> {
	return task.then(
		() => undefined,
		(error: unknown) => showError(errorMessage(error)),
	);
}

/** Runs a selector action from a key handler, where a throw would end the process; reports it instead. */
export function reportSyncFailure(action: () => void, showError: (message: string) => void): boolean {
	try {
		action();
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}
