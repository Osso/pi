import { extractAnsiCode } from "./utils.ts";

// C0 controls other than tab and newline, DEL, and C1 controls.
const TERMINAL_CONTROL_REGEX = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const SGR_REGEX = /^\x1b\[[\d;:]*m$/;
// ECMA-48 CSI: parameter bytes, intermediate bytes, then one final byte. extractAnsiCode only knows the
// final bytes the renderer emits, so it would run past a cursor movement such as ESC [ 1 A.
const CSI_REGEX = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/y;

function extractControlSequence(text: string, index: number): { code: string; length: number } | null {
	CSI_REGEX.lastIndex = index;
	const csi = CSI_REGEX.exec(text)?.[0];
	return csi ? { code: csi, length: csi.length } : extractAnsiCode(text, index);
}

/**
 * Model and extension text can carry raw terminal controls (title, clipboard, cursor, screen
 * clears) that would execute when the rendered line is written. Keep SGR styling, drop the rest.
 */
export function stripTerminalControls(text: string): string {
	if (!TERMINAL_CONTROL_REGEX.test(text)) return text;
	let result = "";
	for (let i = 0; i < text.length; ) {
		const ansi = text[i] === "\x1b" ? extractControlSequence(text, i) : null;
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
