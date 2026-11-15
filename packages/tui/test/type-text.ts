/** Sends each character of `text` as its own input event, like a user typing it. */
export function typeText(target: { handleInput(data: string): void }, text: string): void {
	for (const character of text) target.handleInput(character);
}
