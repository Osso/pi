import { extractAnsiCode } from "./utils.ts";

// C0 controls other than tab and newline, DEL, and C1 controls.
const TERMINAL_CONTROL_REGEX = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const SGR_REGEX = /^\x1b\[[\d;:]*m$/;

/**
 * Model and extension text can carry raw terminal controls (title, clipboard, cursor, screen
 * clears) that would execute when the rendered line is written. Keep SGR styling, drop the rest.
 */
export function stripTerminalControls(text: string): string {
	if (!TERMINAL_CONTROL_REGEX.test(text)) return text;
	let result = "";
	for (let i = 0; i < text.length; ) {
		const ansi = text[i] === "\x1b" ? extractAnsiCode(text, i) : null;
		if (ansi) {
			if (SGR_REGEX.test(ansi.code)) result += ansi.code;
			i += ansi.length;
			continue;
		}
		if (!TERMINAL_CONTROL_REGEX.test(text[i] ?? "")) result += text[i];
		i++;
	}
	return result;
}
