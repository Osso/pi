export interface CompactionQueuePromptOptions<TMessage> {
	messages: readonly TMessage[];
	isExtensionCommand: (message: TMessage) => boolean;
	deliver: (message: TMessage) => Promise<void>;
	prompt: (message: TMessage, preflightResult: (accepted: boolean) => void) => Promise<void>;
	onPromptError: (error: unknown, accepted: boolean) => void;
	onDeliveryError: (error: unknown) => void;
}

export async function deliverCompactionQueuePrompts<TMessage>(
	options: CompactionQueuePromptOptions<TMessage>,
): Promise<void> {
	for (const [index, message] of options.messages.entries()) {
		if (options.isExtensionCommand(message)) {
			await options.deliver(message).catch(options.onDeliveryError);
			continue;
		}

		let promptAccepted = false;
		let resolvePreflight: (accepted: boolean) => void = () => {};
		const preflight = new Promise<boolean>((resolve) => {
			resolvePreflight = resolve;
		});
		void options
			.prompt(message, (accepted) => {
				promptAccepted = accepted;
				resolvePreflight(accepted);
			})
			.then(
				() => {
					if (!promptAccepted) resolvePreflight(true);
				},
				(error) => {
					options.onPromptError(error, promptAccepted);
					if (!promptAccepted) resolvePreflight(false);
				},
			);

		if (await preflight) {
			for (const rest of options.messages.slice(index + 1)) {
				await options.deliver(rest).catch(options.onDeliveryError);
			}
			return;
		}
	}
}
