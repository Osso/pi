/**
 * Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode control bytes inside bracketed paste
 * as CSI-u Ctrl+<letter> sequences (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so a later
 * control-character filter does not strip ESC and leak the printable tail (e.g. "[106;5u") into the text.
 */
export function decodePastedControlKeys(text: string): string {
	return text.replace(/\x1b\[(\d+);5u/g, (match, code) => {
		const cp = Number(code);
		if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
		if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
		return match;
	});
}
