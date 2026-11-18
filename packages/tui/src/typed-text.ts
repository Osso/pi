import { decodePrintableKey } from "./keys.ts";

/**
 * Text a key press types into a text field: Kitty CSI-u and modifyOtherKeys printable keys (such as
 * shift+space under tmux) decoded, plain text as is, anything with a C0/DEL/C1 control character rejected.
 */
export function decodeTypedText(data: string): string | undefined {
	const printable = decodePrintableKey(data);
	if (printable !== undefined) return printable;
	const hasControlChars = [...data].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
	return data.length > 0 && !hasControlChars ? data : undefined;
}
